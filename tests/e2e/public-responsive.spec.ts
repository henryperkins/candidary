import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { measureDocument } from './helpers/geometry';

// The audit's phone matrix. 430 has no fold pair because the audit only records its composition.
const FOLD_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
];
const PHONE_WIDTHS = [320, 360, 390, 430];
// 761 is the guest enhancement boundary; 780 and 860 sit inside the tablet band above it.
const TABLET_WIDTHS = [761, 780, 860];
// The design system holds workflow body copy readable; below this a step reads as a broken column.
const MIN_STEP_TEXT_WIDTH = 160;

async function countGridTracks(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
}

async function measureFold(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const fold = await page.evaluate(() => window.innerHeight);
  return { fold, top: box?.y ?? 0, bottom: (box?.y ?? 0) + (box?.height ?? 0) };
}

test('the landing headline and primary action lead the first fold on phones', async ({ page }) => {
  for (const { width, height } of FOLD_VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.goto('/');

    const headline = page.getByRole('heading', { level: 1 });
    const action = page.getByRole('link', { name: 'Create your event', exact: true });
    await expect(headline).toBeVisible();
    await expect(action).toBeVisible();

    const headlineBounds = await measureFold(page, headline);
    expect(headlineBounds.bottom, `headline within the ${width} by ${height} fold`)
      .toBeLessThanOrEqual(headlineBounds.fold);

    const actionBounds = await measureFold(page, action);
    expect(actionBounds.bottom, `primary action within the ${width} by ${height} fold`)
      .toBeLessThanOrEqual(actionBounds.fold);

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

test('the landing copy precedes the decorative hero image on phones', async ({ page }) => {
  for (const width of PHONE_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');

    const headline = await measureFold(page, page.getByRole('heading', { level: 1 }));
    const image = await measureFold(page, page.locator('.hero__image'));
    expect(image.top, `hero image follows the headline at ${width}`).toBeGreaterThan(headline.bottom);

    expect(await countGridTracks(page.locator('.hero')), `hero columns at ${width}`).toBe(1);
    expect(await countGridTracks(page.locator('.workflow ol')), `workflow columns at ${width}`).toBe(1);

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

test('workflow steps keep a readable text column across the tablet band', async ({ page }) => {
  for (const width of TABLET_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.workflow li')).toHaveCount(3);

    expect(await countGridTracks(page.locator('.workflow ol')), `workflow columns at ${width}`).toBe(2);

    const stepWidths = await page.locator('.workflow li p').evaluateAll(
      (elements) => elements.map((element) => element.getBoundingClientRect().width),
    );
    expect(stepWidths).toHaveLength(3);
    stepWidths.forEach((stepWidth, index) => {
      expect(stepWidth, `workflow step ${index + 1} text width at ${width}`)
        .toBeGreaterThanOrEqual(MIN_STEP_TEXT_WIDTH);
    });

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

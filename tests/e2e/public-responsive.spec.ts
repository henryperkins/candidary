import { expect, test } from '@playwright/test';

import { measureDocument, measureFold, measureGridTracks } from './helpers/geometry';

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
// Both sides of the two breakpoints this surface introduces, so neither can be moved unnoticed.
const LANDING_BOUNDARIES = [
  { width: 699, workflowColumns: 1, heroColumns: 1 },
  { width: 700, workflowColumns: 2, heroColumns: 1 },
  { width: 899, workflowColumns: 2, heroColumns: 1 },
  { width: 900, workflowColumns: 3, heroColumns: 2 },
];

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

    expect((await measureGridTracks(page.locator('.hero'))).length, `hero columns at ${width}`).toBe(1);
    expect((await measureGridTracks(page.locator('.workflow ol'))).length, `workflow columns at ${width}`)
      .toBe(1);

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

test('workflow steps keep a readable text column across the tablet band', async ({ page }) => {
  for (const width of TABLET_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.workflow li')).toHaveCount(3);

    expect((await measureGridTracks(page.locator('.workflow ol'))).length, `workflow columns at ${width}`)
      .toBe(2);

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

test('the landing workflow and hero turn over exactly at their breakpoints', async ({ page }) => {
  for (const { width, workflowColumns, heroColumns } of LANDING_BOUNDARIES) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.workflow li')).toHaveCount(3);

    const workflowTracks = await measureGridTracks(page.locator('.workflow ol'));
    expect(workflowTracks.length, `workflow columns at ${width}`).toBe(workflowColumns);

    const heroTracks = await measureGridTracks(page.locator('.hero'));
    expect(heroTracks.length, `hero columns at ${width}`).toBe(heroColumns);

    const copy = await page.locator('.hero__copy').boundingBox();
    const image = await page.locator('.hero__image').boundingBox();
    if (!copy || !image) throw new Error(`the hero copy and image must both be laid out at ${width}`);

    if (heroColumns === 1) {
      expect(image.y, `hero image stacks under the copy at ${width}`)
        .toBeGreaterThanOrEqual(copy.y + copy.height);
    } else {
      expect(image.x, `hero image sits beside the copy at ${width}`)
        .toBeGreaterThanOrEqual(copy.x + copy.width);
      expect(image.y, `hero image shares the copy row at ${width}`).toBeLessThan(copy.y + copy.height);
    }

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

import { expect, test } from '@playwright/test';

import { MANAGER_MEDIA_PAGE_SIZE } from '../../shared/constants';
import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';
import { measureDocument, measureFold, measureTarget } from './helpers/geometry';

// A wedding-scale event. The route hands out one page at a time, exactly as the paginated endpoint does.
const STORED_PHOTOS = 120;
const rows = makeMedia(STORED_PHOTOS);
const mediaPages = {
  first: { media: rows.slice(0, MANAGER_MEDIA_PAGE_SIZE), nextCursor: 'page-two' },
  'page-two': { media: rows.slice(MANAGER_MEDIA_PAGE_SIZE, MANAGER_MEDIA_PAGE_SIZE * 2), nextCursor: null },
};
const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;

test('paginates intake instead of loading every stored photo', async ({ page }) => {
  const previewRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/media\/[^/]+\/preview$/u.test(request.url())) previewRequests.push(request.url());
  });
  await stubManagerRoutes(page, { mediaPages, event: { storedMediaCount: STORED_PHOTOS } });

  // A phone, not whichever viewport the project happens to carry: the claims below are about the phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();

  const previews = page.locator('.moderation-grid img');
  await expect(previews).toHaveCount(MANAGER_MEDIA_PAGE_SIZE);
  // 120 photos are stored, so paging alone caps the phone at one page of previews; laziness then keeps
  // it to the handful actually near the viewport of a grid that runs past 10,000 px.
  expect(previewRequests.length).toBeLessThan(MANAGER_MEDIA_PAGE_SIZE);
  for (const preview of await previews.all()) {
    await expect(preview).toHaveAttribute('loading', 'lazy');
    await expect(preview).toHaveAttribute('decoding', 'async');
  }

  const more = page.getByRole('button', { name: 'Load more photos' });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const moreSize = await measureTarget(more);
    expect(moreSize.width, `${width} px load-more width`).toBeGreaterThanOrEqual(44);
    expect(moreSize.height, `${width} px load-more height`).toBeGreaterThanOrEqual(44);
    const firstPageSize = await measureDocument(page);
    expect(firstPageSize.scrollWidth, `${width} px first page`).toBeLessThanOrEqual(firstPageSize.clientWidth + 1);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await more.click();
  await expect(previews).toHaveCount(MANAGER_MEDIA_PAGE_SIZE * 2);
  const sources = await previews.evaluateAll((images) => images.map((image) => image.getAttribute('src')));
  expect(new Set(sources).size).toBe(MANAGER_MEDIA_PAGE_SIZE * 2);
  // The page-two response ends the keyset, so the control that reached it is gone.
  await expect(more).toHaveCount(0);

  const secondPageSize = await measureDocument(page);
  expect(secondPageSize.scrollWidth).toBeLessThanOrEqual(secondPageSize.clientWidth + 1);
});

test('exposes export in the mobile share section rather than below the intake grid', async ({ page }) => {
  await stubManagerRoutes(page, { mediaPages, event: { storedMediaCount: STORED_PHOTOS } });

  // The Share placement is the phone's, so pin the phone rather than inherit the project viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await expect(page.locator('.moderation-grid')).toBeVisible();
  // Intake is where the 120-photo grid lives. At phone width it carries no export control at all, so
  // there is nothing to bury underneath that grid — the rail copy is the only one in the document.
  await expect(page.locator('.manager-export-panel')).toHaveCount(1);
  await expect(page.locator('.manager-export-panel')).toBeHidden();

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const sharePanel = page.locator('.manager-export-panel--share');
  const utilityPanel = page.locator('.manager-export-panel--utility');
  await expect(sharePanel).toBeVisible();
  // One presentation reused: only the Share copy is on screen at phone widths.
  await expect(utilityPanel).toBeHidden();

  const prepare = sharePanel.getByRole('button', { name: 'Prepare download' });
  await expect(prepare).toBeVisible();
  const prepareSize = await measureTarget(prepare);
  expect(prepareSize.width).toBeGreaterThanOrEqual(44);
  expect(prepareSize.height).toBeGreaterThanOrEqual(44);

  // Share is short enough that the whole export panel is reached within one screen of scrolling from
  // the top of the manager — the property that makes attaching it here worth anything.
  const bounds = await measureFold(page, sharePanel);
  expect(bounds.bottom, 'export reached within one screen of scrolling').toBeLessThanOrEqual(bounds.fold * 2);

  const shareSize = await measureDocument(page);
  expect(shareSize.scrollWidth).toBeLessThanOrEqual(shareSize.clientWidth + 1);

  // Past the 761 px enhancement the utility rail is on screen and carries the same panel instead.
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(utilityPanel).toBeVisible();
  await expect(sharePanel).toBeHidden();
  await expect(utilityPanel.getByRole('button', { name: 'Prepare download' })).toBeVisible();

  const wideSize = await measureDocument(page);
  expect(wideSize.scrollWidth).toBeLessThanOrEqual(wideSize.clientWidth + 1);
});

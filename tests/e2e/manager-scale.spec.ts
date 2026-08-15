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
  'page-two': {
    media: rows.slice(MANAGER_MEDIA_PAGE_SIZE, MANAGER_MEDIA_PAGE_SIZE * 2),
    nextCursor: 'page-three',
  },
  'page-three': {
    media: rows.slice(MANAGER_MEDIA_PAGE_SIZE * 2, MANAGER_MEDIA_PAGE_SIZE * 3),
    nextCursor: 'page-four',
  },
  'page-four': {
    media: rows.slice(MANAGER_MEDIA_PAGE_SIZE * 3, MANAGER_MEDIA_PAGE_SIZE * 4),
    nextCursor: 'page-five',
  },
  'page-five': {
    media: rows.slice(MANAGER_MEDIA_PAGE_SIZE * 4),
    nextCursor: null,
  },
};
const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;
// `ManagerPage` polls intake on this interval; the number lives there and is mirrored here so the
// wait below is measured against the real thing rather than a guess.
const INTAKE_POLL_MS = 5_000;

test('paginates intake instead of loading every stored photo', async ({ page }) => {
  test.setTimeout(60_000);
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
  for (let pageNumber = 2; pageNumber <= 5; pageNumber += 1) {
    await more.click();
    await expect(previews).toHaveCount(MANAGER_MEDIA_PAGE_SIZE * pageNumber);
  }
  const sources = await previews.evaluateAll((images) => images.map((image) => image.getAttribute('src')));
  expect(new Set(sources).size).toBe(STORED_PHOTOS);
  // The fifth 24-row page ends the 120-photo keyset, so the control that reached it is gone.
  await expect(more).toHaveCount(0);
  // Let the real interval issue a cursor-less first-page poll and let the normal route answer it.
  // An exhausted cursor is state, so this overlap refresh must not reopen page two.
  await page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/manage/events/${EVENT_FIXTURE.id}/media`
      && !url.searchParams.has('cursor');
  }, { timeout: INTAKE_POLL_MS * 3 });
  await expect(more, 'an answered poll keeps the exhausted keyset exhausted').toHaveCount(0);
  await expect(previews, 'an answered poll retains all five pages').toHaveCount(STORED_PHOTOS);

  const secondPageSize = await measureDocument(page);
  expect(secondPageSize.scrollWidth).toBeLessThanOrEqual(secondPageSize.clientWidth + 1);
});

test('exposes the one export control inside the private gallery', async ({ page }) => {
  await stubManagerRoutes(page, { mediaPages, event: { storedMediaCount: STORED_PHOTOS } });

  // A phone, not whichever viewport the project happens to carry.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await expect(page.locator('.moderation-grid')).toBeVisible();
  // Intake carries no export control at all: the 120-photo grid has nothing to bury underneath it.
  await expect(page.locator('.gallery-export')).toHaveCount(0);

  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
  const control = page.locator('.gallery-export');
  await expect(control).toBeVisible();
  await expect(page.locator('.gallery-export')).toHaveCount(1);

  const prepare = control.getByRole('button', { name: 'Download all' });
  await expect(prepare).toBeVisible();
  const prepareSize = await measureTarget(prepare);
  expect(prepareSize.width).toBeGreaterThanOrEqual(44);
  expect(prepareSize.height).toBeGreaterThanOrEqual(44);

  // The export control sits beside the header, reached within one screen of the gallery.
  const bounds = await measureFold(page, control);
  expect(bounds.bottom, 'export reached within one screen of scrolling').toBeLessThanOrEqual(bounds.fold * 2);

  const phoneSize = await measureDocument(page);
  expect(phoneSize.scrollWidth).toBeLessThanOrEqual(phoneSize.clientWidth + 1);

  // The same single control serves the wide rail layout too.
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(control).toBeVisible();
  await expect(page.locator('.gallery-export')).toHaveCount(1);
  await expect(control.getByRole('button', { name: 'Download all' })).toBeVisible();

  const wideSize = await measureDocument(page);
  expect(wideSize.scrollWidth).toBeLessThanOrEqual(wideSize.clientWidth + 1);
});

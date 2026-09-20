import { expect, test, type Page, type Locator } from '@playwright/test';

import { EVENT_FIXTURE, stubLibraryRoutes } from './fixtures/routes';

import { PHOTOGRAPHIC_COVER } from './fixtures/cover-images';

const base = `/manage/event/${EVENT_FIXTURE.id}`;

const out = 'output/playwright/library-consolidation';

const sizes = [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }, { name: 'narrow', width: 320, height: 568 }];

const tiles = (page: Page) => page.locator('.gallery-private [data-photo-id]');

async function target(control: Locator) { const b = await control.boundingBox(); expect(b).not.toBeNull(); expect(b!.width).toBeGreaterThanOrEqual(44); expect(b!.height).toBeGreaterThanOrEqual(44); }

async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1); }

async function wake(page: Page) { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); }

async function open(page: Page, count = 96) { const fixture = await stubLibraryRoutes(page, count); await page.goto(base); await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible(); if(count) await expect(tiles(page).first()).toBeVisible(); return fixture; }

for (const size of sizes) test(`${size.name}: Photo Wall, navigation, keyboard targets and viewport`, async ({ page }) => {

  await page.setViewportSize(size); await page.emulateMedia({ reducedMotion: 'reduce' });

  await stubLibraryRoutes(page, 96); await page.goto(`${base}?section=intake`);

  await expect(page).toHaveURL(base); await expect(tiles(page).first()).toBeVisible();

  await expect(page.getByRole('group', { name: 'Gallery mode' }).getByRole('button')).toHaveCount(3);

  await expect(page.getByRole('navigation', { name: 'Manager sections' }).getByRole('button', { name: 'Intake' })).toHaveCount(0);

  const first = await tiles(page).first().boundingBox(); expect(first!.y).toBeLessThan(size.height - 20);

  if (size.width < 761) expect(await page.locator('.gallery-photo-wall').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(2);

  await noOverflow(page);

  for (const control of [page.getByRole('button', { name: 'Add photos', exact: true }), page.getByRole('button', { name: /^Trash/ }), page.getByRole('group', { name: 'Gallery mode' }).getByRole('button').first(), tiles(page).first().locator('.gallery-photo__album')]) await target(control);

  await page.getByRole('button', { name: 'Add photos', exact: true }).focus(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: /^Trash/ })).toBeFocused();

  expect(await page.getByRole('button', { name: /^Trash/ }).evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');

  await page.screenshot({ path: `${out}/${size.name}-library.png`, fullPage: false });

  console.log(size.name, { firstPhotoY: first!.y, width: size.width, height: size.height });

});

test('arrivals retain viewer, selection, query, order and a rendered anchor through a multi-page burst', async ({ page }) => {

  await page.setViewportSize(sizes[0]!); await page.emulateMedia({ reducedMotion: 'reduce' });

  test.setTimeout(60000);
  const fixture = await open(page, 180);

  await page.getByPlaceholder('Search photos').fill('Avery'); await page.getByRole('button', { name: 'Search', exact: true }).click();

  await page.getByLabel('Photos shown').selectOption('album'); await page.getByLabel('Photo order').selectOption('earliest'); await page.getByLabel('Photo order').selectOption('newest');

  await expect(tiles(page)).toHaveCount(48);

  await tiles(page).nth(18).locator('.gallery-mosaic__open').click(); const viewer = page.getByRole('dialog'); const title = await viewer.getAttribute('aria-labelledby');

  fixture.deliver(65); await wake(page); await page.waitForTimeout(5200);

  await expect(viewer).toBeVisible(); expect(await viewer.getAttribute('aria-labelledby')).toBe(title);

  await page.getByRole('button', { name: 'Close viewer' }).click();

  await expect(page.getByRole('button', { name: '65 new photos' })).toBeVisible();

  await page.getByRole('button', { name: 'Select photos', exact: true }).click();

  const selected = tiles(page).nth(18); const id = await selected.getAttribute('data-photo-id'); await selected.locator('.gallery-mosaic__open').click();

  await selected.evaluate(el => window.scrollBy({ top: el.getBoundingClientRect().top - 200, behavior: 'instant' })); const before = await selected.boundingBox(); const scroll = await page.evaluate(() => scrollY);

  const anchorBefore = await tiles(page).evaluateAll(elements => { const el = elements.find(el => el.getBoundingClientRect().bottom > 0)!; return { id: el.getAttribute('data-photo-id'), y: el.getBoundingClientRect().top }; });
  const anchor = page.locator(`[data-photo-id="${anchorBefore.id}"]`);
  fixture.setFailures({ poll: true }); await wake(page); await page.waitForTimeout(5200);

  expect(await page.evaluate(() => scrollY)).toBe(scroll); expect((await selected.boundingBox())!.y).toBeCloseTo(before!.y, 0);

  fixture.setFailures({ poll: false });

  // Activate without Playwright scrolling the arrival control into view; anchor is measured at the click.

  const requestsBeforeAcceptance = fixture.requests.length;
  await page.getByRole('button', { name: '65 new photos' }).evaluate((el: HTMLButtonElement) => el.click());

  await expect(page.getByRole('button', { name: '65 new photos' })).toHaveCount(0);

  const retained = page.locator(`[data-photo-id="${id}"]`);
  await expect.poll(async () => (await anchor.boundingBox())!.y).toBeCloseTo(anchorBefore.y, 0);

  await expect(retained.locator('.gallery-mosaic__open')).toHaveAttribute('aria-pressed', 'true');

  await expect(page.getByPlaceholder('Search photos')).toHaveValue('Avery'); await expect(page.getByLabel('Photos shown')).toHaveValue('album'); await expect(page.getByLabel('Photo order')).toHaveValue('newest');

  expect(fixture.requests.slice(requestsBeforeAcceptance).filter(url => url.includes('/gallery?')).length).toBeGreaterThan(1);
  await page.getByRole('button', { name: /^Trash/ }).evaluate((el: HTMLButtonElement) => el.click());
  await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Library' }).click();
  await expect(retained.locator('.gallery-mosaic__open')).toHaveAttribute('aria-pressed', 'true');
  await expect(retained).toBeVisible();
  await expect.poll(async () => (await anchor.boundingBox())?.y).toBeCloseTo(anchorBefore.y, 0);
  console.log('arrival anchor', { selectedId: id, anchorId: anchorBefore.id, before: anchorBefore.y, after: (await anchor.boundingBox())!.y, acceptedPages: fixture.requests.slice(requestsBeforeAcceptance).filter(url => url.includes('/gallery?')).length });

});

test('narrow viewer confirmation, authenticated original, failure, successor, Undo and Trash context', async ({ page }) => {

  await page.setViewportSize(sizes[2]!); const fixture = await open(page, 3);

  const id = await tiles(page).first().getAttribute('data-photo-id'); await tiles(page).first().locator('.gallery-mosaic__open').click();

  await expect(page.getByRole('link', { name: 'Download original', exact: true })).toHaveAttribute('href', `/api/media/${id}/original`);

  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(1); await expect(page.getByRole('button', { name: 'Keep photo' })).toBeFocused();

  const confirmationHeading = page.getByRole('heading', { name: 'Move this photo to Trash?' });
  const headingBounds = (await confirmationHeading.boundingBox())!;
  const keepBounds = (await page.getByRole('button', { name: 'Keep photo' }).boundingBox())!;
  expect(headingBounds.y).toBeGreaterThanOrEqual(0); expect(headingBounds.y + headingBounds.height).toBeLessThan(keepBounds.y);
  expect(keepBounds.y + keepBounds.height).toBeLessThanOrEqual(568);
  await target(page.getByRole('button', { name: 'Keep photo' }));
  console.log('confirmation bounds', { heading: headingBounds, keep: keepBounds });
  await page.screenshot({ path: `${out}/narrow-confirmation.png` }); await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Keep photo' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click(); await page.locator('.gallery-viewer--confirmation').click({ position: { x: 2, y: 2 } }); await expect(page.getByRole('button', { name: 'Keep photo' })).toHaveCount(0);

  fixture.setFailures({ trash: true }); await page.getByRole('button', { name: 'Move to Trash', exact: true }).click(); await page.getByRole('button', { name: 'Move to Trash', exact: true }).click(); await expect(page.getByRole('dialog').getByText('Local connection interrupted.')).toBeVisible();

  fixture.setFailures({ trash: false }); await page.getByRole('button', { name: 'Move to Trash', exact: true }).click(); await page.getByRole('button', { name: 'Move to Trash', exact: true }).click(); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();

  const bar = await page.locator('.album-undo__bar').boundingBox(), actions = await page.locator('.gallery-viewer__file-actions').boundingBox(); expect(bar!.y + bar!.height).toBeLessThanOrEqual(actions!.y);

  await page.getByRole('button', { name: 'Close viewer' }).click(); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(page.locator(`[data-photo-id="${id}"]`)).toHaveCount(1);

  await page.getByRole('button', { name: /^Trash/ }).click(); await expect(page).toHaveURL(`${base}?section=gallery&view=trash`); await page.getByRole('button', { name: 'Back to Library' }).click(); await expect(page.getByRole('button', { name: /^Trash/ })).toBeFocused();

  await page.goBack(); await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible(); await page.goForward(); await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible(); await noOverflow(page);

});

test('Trash exact and expired deadlines and later-page recovery intent', async ({ page }) => {

  await page.setViewportSize(sizes[2]!); const fixture = await stubLibraryRoutes(page, 1);

  const retained = Array.from({ length: 51 }, (_, i) => ({ id: `retained-${i}`, originalFilename: `retained-${i}.jpg`, caption: null, guestName: 'Avery', trashedAt: '2026-09-14T00:00:00.000Z', restoreUntil: i === 0 ? '2020-01-01T00:00:00.000Z' : '2026-10-19T00:00:00.000Z' })); fixture.setTrash(retained);

  await page.goto(`${base}?section=gallery&view=trash`); await expect(page.getByText('Recovery expired · cleanup pending')).toBeVisible(); await expect(page.locator('[data-trash-media-id="retained-0"] button')).toHaveCount(0); await expect(page.locator('[data-trash-media-id="retained-1"] time')).toHaveAttribute('datetime', '2026-10-19T00:00:00.000Z'); await page.screenshot({ path: `${out}/narrow-trash.png` });

  await page.evaluate(({ base, eventId }) => { history.pushState({ ...history.state, usr: { foreign: 'kept', __candidaryManager: { version: 1, eventId, intent: { kind: 'open-recently-deleted', focusMediaId: 'retained-50' } } } }, '', `${base}?section=intake`); location.reload(); }, { base, eventId: EVENT_FIXTURE.id });

  await expect(page.getByRole('button', { name: 'Restore retained-50.jpg' })).toBeFocused(); expect(fixture.requests.some(url => url.includes('/media/trash?cursor=48'))).toBe(true); await page.getByRole('button', { name: 'Restore retained-50.jpg' }).click(); await expect(page.getByRole('button', { name: 'Restore retained-50.jpg' })).toHaveCount(0); await noOverflow(page);

});

test('narrow manager upload chooser progress receipt and restoration', async ({ page }) => {

  await page.setViewportSize(sizes[2]!); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); await stubLibraryRoutes(page, 1, { contentGate: gate }); await page.goto(base);

  const add = page.getByRole('button', { name: 'Add photos', exact: true }); await add.click(); const dialog = page.getByRole('dialog', { name: 'Add photos' });

  for (const name of ['Take a photo', 'Choose recent photos', 'Close Add photos']) { const control = dialog.getByRole('button', { name, exact: true }); await expect(control).toBeVisible(); await target(control); }

  expect(await dialog.locator('.source-button').first().evaluate(el => getComputedStyle(el).color)).toBe('rgb(74, 36, 21)'); expect(await dialog.locator('.photo-drop--manager').evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(500);

  await page.screenshot({ path: `${out}/narrow-upload-chooser.png` });

  await dialog.getByLabel('Choose recent photos from your library').setInputFiles({ name: 'host-photo.png', mimeType: 'image/png', buffer: PHOTOGRAPHIC_COVER }); await dialog.getByRole('button', { name: 'Send 1 photo' }).click(); await expect(dialog.getByRole('button', { name: 'Cancel uploads' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toBeVisible(); release();

  await expect(dialog.getByRole('button', { name: 'Return to Library' })).toBeFocused(); await expect(dialog.locator('.photo-drop--manager')).toHaveCount(1); await noOverflow(page); await page.screenshot({ path: `${out}/narrow-upload-receipt.png` });

  await dialog.getByRole('button', { name: 'Return to Library' }).click(); await expect(add).toBeFocused(); await expect(tiles(page)).toHaveCount(1);

});

test('failed accepted refresh retains photos, empty Library and 10k bounded pagination', async ({ page }) => {

  await page.setViewportSize(sizes[1]!); const fixture = await open(page, 10000); await expect(tiles(page)).toHaveCount(48); fixture.deliver(50); await wake(page); await expect(page.getByRole('button', { name: '50 new photos' })).toBeVisible(); fixture.setFailures({ refresh: true }); await page.getByRole('button', { name: '50 new photos' }).click(); await expect(page.getByRole('alert').filter({ hasText: 'Could not load new photos.' })).toBeVisible(); await expect(tiles(page)).toHaveCount(48);

  const lists = fixture.requests.filter(url => url.includes('/gallery?')); expect(lists.filter(url => url.includes('cursor='))).toHaveLength(0); expect(fixture.requests.some(url => url.includes('/arrivals?'))).toBe(true);

  await page.getByPlaceholder('Search photos').fill('no match'); await page.getByRole('button', { name: 'Search', exact: true }).click(); await expect(page.getByRole('heading', { name: 'No photos match this search.' })).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' }); await stubLibraryRoutes(page, 0); await page.goto(base); await expect(page.getByText('Photos added by you or your guests appear here.')).toBeVisible(); await noOverflow(page);

});

test('single-photo empty deletion and continuation failure keep recovery available', async ({ page }) => {
  await page.setViewportSize(sizes[2]!); await open(page, 1);
  await tiles(page).first().locator('.gallery-mosaic__open').click();
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.gallery-private')).toBeFocused(); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' }); const fixture = await stubLibraryRoutes(page, 49); fixture.setFailures({ continuation: true }); await page.goto(base); await expect(tiles(page)).toHaveCount(48);
  await tiles(page).last().locator('.gallery-mosaic__open').click();
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click(); await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(page.getByText('Photo moved to Trash. Could not load the next photo.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeFocused(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeFocused();
  fixture.setFailures({ continuation: false }); await page.getByRole('button', { name: 'Retry', exact: true }).click(); await expect(page.getByRole('button', { name: 'Download original', exact: true })).toHaveCount(0); await expect(page.getByRole('link', { name: 'Download original', exact: true })).toBeVisible();
});

test('narrow partial delivery and cleanup recovery retain Library receipt and keyboard containment', async ({ page }) => {
  await page.setViewportSize(sizes[2]!); await stubLibraryRoutes(page, 1, { cancelFailure: 'network' });
  await page.route('**/uploads/manager-upload-2/content', route => route.abort('connectionclosed'));
  await page.goto(base); const add = page.getByRole('button', { name: 'Add photos', exact: true }); await add.click(); const dialog = page.getByRole('dialog', { name: 'Add photos' });
  await dialog.getByLabel('Choose recent photos from your library').setInputFiles([{ name: 'good.png', mimeType: 'image/png', buffer: PHOTOGRAPHIC_COVER }, { name: 'retry.png', mimeType: 'image/png', buffer: PHOTOGRAPHIC_COVER }]);
  await dialog.getByRole('button', { name: 'Send 2 photos' }).click(); await expect(dialog.getByRole('button', { name: 'Retry 1 photo' })).toBeVisible(); await dialog.getByRole('button', { name: 'Cancel uploads' }).click();
  const retry = dialog.getByRole('button', { name: 'Retry cleanup' }); await expect(retry).toBeFocused(); await expect(dialog.getByText('1 temporary upload still needs cleanup.')).toBeVisible(); await expect(dialog.getByText(/already safe in Library/)).toBeVisible();
  await target(retry); await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true); await noOverflow(page);
  await page.route('**/uploads/manager-upload-2', route => route.fulfill({ json: { data: { media: { id: 'manager-upload-2', uploadState: 'deleted', mimeType: 'image/png' } }, requestId: 'cleanup-recovered' } }));
  await retry.click(); await expect(dialog).toHaveCount(0); await expect(add).toBeFocused();
});

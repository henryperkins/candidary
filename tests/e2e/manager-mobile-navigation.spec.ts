import { expect, test } from '@playwright/test';
import { EVENT_FIXTURE, stubLibraryRoutes, stubManagerRoutes } from './fixtures/routes';
import { chooseManagerSection, openManagerNavigation } from './helpers/manager-navigation';

const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;

test('mobile section disclosure exposes all destinations without moving the Library', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await stubLibraryRoutes(page, 96);
  await page.goto(managerUrl);
  const firstPhoto = page.locator('.gallery-private [data-photo-id]').first();
  await expect(firstPhoto).toBeVisible();
  const before = await firstPhoto.boundingBox();
  const toggle = page.getByRole('button', { name: /^Gallery, open navigation/ });
  await expect(toggle).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Manager sections' })).toBeHidden();
  await toggle.click();
  const navigation = page.getByRole('navigation', { name: 'Manager sections' });
  await expect(navigation.getByRole('button')).toHaveCount(5);
  for (const name of ['Gallery', 'RSVP', 'Guestbook', 'Share', 'Settings']) {
    const button = navigation.getByRole('button', { name: new RegExp(`^${name}`) });
    await expect(button).toBeInViewport();
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect((await firstPhoto.boundingBox())!.y).toBe(before!.y);
  await page.keyboard.press('Tab');
  await expect(navigation.getByRole('button', { name: 'Gallery', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(navigation).toBeHidden();
});

for (const width of [320, 390]) test(`mobile header serves all five sections at ${width}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
  await stubLibraryRoutes(page, 96);
  await page.goto(managerUrl);
  const toggle = page.locator('.manager-nav__toggle');
  await expect(toggle).toContainText('Gallery');
  await page.screenshot({ path: testInfo.outputPath('library-header.png') });
  await openManagerNavigation(page);
  await page.screenshot({ path: testInfo.outputPath('section-menu.png') });
  // The event heading is under the overlay. Use the exposed left gutter.
  const menuBounds = (await page.locator('.manager-nav nav').boundingBox())!;
  await page.mouse.click(menuBounds.x / 2, menuBounds.y + 20);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  for (const name of ['RSVP', 'Guestbook', 'Share', 'Settings']) {
    await chooseManagerSection(page, name);
    await expect(toggle).toContainText(name);
    await expect(page.getByRole('navigation', { name: 'Manager sections' })).toBeHidden();
    await expect(page.getByRole('heading', { name: EVENT_FIXTURE.name, exact: true })).toBeVisible();
    await expect(page.locator('.manager-title .lifecycle')).toBeHidden();
    expect((await page.locator('.manager-nav').boundingBox())!.height).toBeLessThanOrEqual(60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`${name.toLowerCase()}-header.png`) });
  }
  await page.locator('.library-event-details > summary').click();
  await expect(page.locator('.library-event-details__body')).toBeVisible();
  await expect(page.locator('.library-event-details__body')).toContainText('Management and exports end');
  await page.locator('.library-event-details > summary').click();
  await page.goBack();
  await expect(toggle).toContainText('Share');
  await page.goForward();
  await expect(toggle).toContainText('Settings');
  await page.reload();
  await expect(toggle).toContainText('Settings');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('menu retains review counts, enlarged text and focus through the rail breakpoint', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    event: { name: 'Alexandria and Christopher celebrate with family and friends' },
    guestbook: { summary: { needsReviewCount: 1000, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true } },
  });
  await page.goto(managerUrl);
  const toggle = page.locator('.manager-nav__toggle');
  await expect(toggle).toHaveAccessibleName(/1000 guestbook notes need review/);
  await expect(toggle.locator('.manager-nav__count')).toHaveText('1000');
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  await openManagerNavigation(page);
  const nav = page.locator('.manager-nav nav');
  await expect(nav.getByRole('button', { name: 'Guestbook 1000', exact: true })).toBeVisible();
  const headerHeight = (await page.locator('.manager-nav').boundingBox())!.height;
  await expect.poll(() => page.locator('.manager-shell').evaluate(el => Number.parseFloat(getComputedStyle(el).getPropertyValue('--manager-sticky-offset')))).toBe(Math.ceil(headerHeight));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('enlarged-menu.png') });
  await page.setViewportSize({ width: 640, height: 450 });
  const last = nav.getByRole('button', { name: 'Settings', exact: true });
  await last.focus();
  await expect(last).toBeInViewport();
  const panel = (await nav.boundingBox())!;
  expect(panel.y + panel.height).toBeLessThanOrEqual(450);
  await page.addStyleTag({ content: 'html { font-size: 100%; }' });
  await toggle.focus();
  await page.setViewportSize({ width: 761, height: 900 });
  await expect(toggle).toBeHidden();
  await expect(nav.getByRole('button', { name: 'Gallery', exact: true })).toBeFocused();
  await expect(nav.getByRole('button')).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath('tablet-rail.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(nav).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-rail.png') });
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toBeHidden();
});

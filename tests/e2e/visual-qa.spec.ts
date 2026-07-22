import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const screenshotDir = 'output/playwright/screenshots';
const hero = readFileSync('public/assets/candidary-hero.png');
const event = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'We would love to see the day through your eyes.', uploadsEnabled: true,
  galleryVisible: true, moderationRequired: true, storedMediaCount: 6, storedBytes: 384,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
};
const media = ['First look', 'Golden hour', 'The toast', 'First dance', 'Garden walk', 'Afterglow'].map((caption, index) => ({
  id: `media-${index + 1}`, originalFilename: `moment-${index + 1}.png`, guestName: ['Avery', 'Jamie', 'Sam'][index % 3],
  caption, publicationStatus: 'published', uploadState: 'stored', width: 1200, height: 900,
}));

async function routeImages(page: Page) {
  await page.route('**/api/media/*/preview', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: hero }));
}

test.beforeAll(async () => { await mkdir(screenshotDir, { recursive: true }); });

test('guest visual reference', async ({ page }, testInfo) => {
  await routeImages(page);
  await page.route('**/api/event/maya-theo', (route) => route.fulfill({ json: { data: { event, role: 'guest' }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/gallery', (route) => route.fulfill({ json: { data: { media }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/contributions', (route) => route.fulfill({ json: { data: { media: [media[0]] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/messages', (route) => route.fulfill({ json: { data: { items: [
    { id: 'message-a', kind: 'message', guestName: 'Rowan', body: 'To a lifetime of noticing the little things.', moderationStatus: 'approved', createdAt: '2026-09-19T20:00:00Z' },
  ] }, requestId: 'r' } }));
  await page.goto('/event/maya-theo');
  await expect(page.getByRole('heading', { name: event.welcomeMessage })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/guest-${testInfo.project.name}.png`, fullPage: true });
});

test('manager visual reference', async ({ page }, testInfo) => {
  await routeImages(page);
  await page.route('**/api/manage/events/event-a', (route) => route.fulfill({ json: { data: { event }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/media*', (route) => route.fulfill({ json: { data: { media: media.map((item) => ({ ...item, publicationStatus: 'unpublished' })) }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/messages', (route) => route.fulfill({ json: { data: { messages: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/exports', (route) => route.fulfill({ json: { data: { exports: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/links', (route) => route.fulfill({ json: { data: { guestLink: `https://candidary.test/join/${'guest-secret-'.repeat(8)}` }, requestId: 'r' } }));
  await page.goto('/manage/event/event-a');
  await expect(page.getByRole('heading', { name: event.name })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/manager-${testInfo.project.name}.png`, fullPage: true });

  if (testInfo.project.name === 'mobile') {
    const navigationButtons = page.locator('.manager-nav nav button');
    await expect(navigationButtons).toHaveCount(5);
    for (const button of await navigationButtons.all()) {
      const box = await button.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    for (const section of ['Gallery', 'Notes', 'Share', 'Settings', 'Intake']) {
      await page.getByRole('button', { name: new RegExp(section, 'iu') }).click();
      const overflow = await page.locator('.manager-main').evaluate((main) => {
        const viewportWidth = document.documentElement.clientWidth;
        return Array.from(main.querySelectorAll<HTMLElement>('*')).flatMap((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.left < -1 || rect.right > viewportWidth + 1)
            ? [{ className: element.className, left: rect.left, right: rect.right }]
            : [];
        });
      });
      expect(overflow, `${section} contains viewport overflow`).toEqual([]);
    }

    await page.getByRole('button', { name: 'Share' }).click();
    await expect(page.locator('.manager-panel img[alt="Guest event QR code"]')).toBeVisible();
    await expect(page.locator('.manager-utility__guest-entry')).toBeHidden();
    await expect(page.locator('.manager-utility__capacity')).toBeHidden();
    await page.screenshot({ path: `${screenshotDir}/manager-share-mobile.png`, fullPage: true });
  }
});

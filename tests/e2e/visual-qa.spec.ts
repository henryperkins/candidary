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
  caption, moderationStatus: 'approved', uploadState: 'stored', width: 1200, height: 900,
}));

async function routeImages(page: Page) {
  await page.route('**/api/media/*/content', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: hero }));
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
  await expect(page.getByRole('heading', { name: event.name })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/guest-${testInfo.project.name}.png`, fullPage: true });
});

test('manager visual reference', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The accepted manager concept is desktop; mobile behavior is covered elsewhere.');
  await routeImages(page);
  await page.route('**/api/manage/events/event-a', (route) => route.fulfill({ json: { data: { event }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/media?status=pending', (route) => route.fulfill({ json: { data: { media: media.map((item) => ({ ...item, moderationStatus: 'pending' })) }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/messages', (route) => route.fulfill({ json: { data: { messages: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/exports', (route) => route.fulfill({ json: { data: { exports: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/links', (route) => route.fulfill({ json: { data: { guestLink: 'https://candidary.test/join/guest-link' }, requestId: 'r' } }));
  await page.goto('/manage/event/event-a');
  await expect(page.getByRole('heading', { name: event.name })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/manager-desktop.png`, fullPage: true });
});

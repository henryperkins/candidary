import { expect, test } from '@playwright/test';

import { EVENT_FIXTURE, eventTheme, stubGuestRoutes } from './fixtures/routes';
import { settleRendering } from './helpers/rendering';

test('application routes never retain access secrets in rendered links', async ({ page }) => {
  await stubGuestRoutes(page, { event: { welcomeMessage: 'Welcome.', galleryVisible: false } });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await expect(page).toHaveURL(new RegExp(`/event/${EVENT_FIXTURE.slug}$`, 'u'));
  await expect(page.locator('a[href*="guest-secret"], a[href*="manager-secret"]')).toHaveCount(0);
});

test('production preview enforces the shipped CSP while themed cover images render', async ({ page }) => {
  const consoleErrors: string[] = [];
  const fontRequests: string[] = [];
  // Keep a real production asset request open long enough to prove the console audit waits for it.
  await page.route(/\/assets\/.*\.woff2?$/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontRequests.push(request.url());
  });
  await stubGuestRoutes(page, {
    event: {
      theme: eventTheme('midnight-film'),
      coverObjectKey: 'events/event-a/cover.png',
    },
  });
  const response = await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(response?.headers()['content-security-policy']).toContain("img-src 'self' blob: data:");
  await expect(page.locator('.photo-drop__hero--cover')).toHaveCSS('background-image', /blob:/u);
  const settlement = await settleRendering(page);
  expect(fontRequests, 'production build requests emitted font assets').not.toEqual([]);
  const pageOrigin = new URL(page.url()).origin;
  expect(fontRequests.every((url) => new URL(url).origin === pageOrigin), 'font assets stay same-origin').toBe(true);
  expect(
    fontRequests.every((url) => /^\/assets\/.*\.woff2?$/u.test(new URL(url).pathname)),
    'font requests are emitted build assets',
  ).toBe(true);
  expect(settlement.fontStatus, 'font work is settled before the console audit').toBe('loaded');
  expect(settlement.frames, 'font status stayed observable across a two-frame boundary').toBeGreaterThanOrEqual(2);
  expect(consoleErrors, 'production CSP emits no browser console error').toEqual([]);
});

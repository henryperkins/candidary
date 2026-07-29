import { expect, test } from '@playwright/test';

import { EVENT_FIXTURE, eventTheme, stubGuestRoutes } from './fixtures/routes';

test('application routes never retain access secrets in rendered links', async ({ page }) => {
  await stubGuestRoutes(page, { event: { welcomeMessage: 'Welcome.', galleryVisible: false } });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await expect(page).toHaveURL(new RegExp(`/event/${EVENT_FIXTURE.slug}$`, 'u'));
  await expect(page.locator('a[href*="guest-secret"], a[href*="manager-secret"]')).toHaveCount(0);
});

test('production preview enforces the shipped CSP while themed cover images render', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
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
  expect(consoleErrors, 'production CSP emits no browser console error').toEqual([]);
});

import { expect, test } from '@playwright/test';

test('application routes never retain access secrets in rendered links', async ({ page }) => {
  await page.route('**/api/event/maya-theo', (route) => route.fulfill({ json: { data: { event: {
    id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
    uploadsEnabled: true, galleryVisible: false, moderationRequired: true,
  }, role: 'guest' }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/contributions', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/messages', (route) => route.fulfill({ json: { data: { items: [] }, requestId: 'r' } }));
  await page.goto('/event/maya-theo');
  await expect(page).toHaveURL(/\/event\/maya-theo$/u);
  await expect(page.locator('a[href*="guest-secret"], a[href*="manager-secret"]')).toHaveCount(0);
});

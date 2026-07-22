import { expect, test } from '@playwright/test';

const event = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'We would love to see the day through your eyes.', uploadsEnabled: true,
  galleryVisible: true, moderationRequired: true, storedMediaCount: 2, storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
};

test('host creates an event and receives both private access links', async ({ page }) => {
  await page.route('**/api/events', (route) => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: {
    event, guestLink: 'https://candidary.test/join/guest-secret', managementLink: 'https://candidary.test/manage/manager-secret', csrfToken: 'csrf-a',
  }, requestId: 'request-a' }) }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Gather the moments you didn’t see.' })).toBeVisible();
  await page.getByRole('link', { name: 'Create your event' }).click();
  await page.getByLabel('Event name').fill(event.name);
  await page.getByLabel('Event date').fill(event.eventDate);
  await page.getByLabel('Welcome message').fill(event.welcomeMessage);
  await page.getByRole('button', { name: 'Create private event' }).click();
  await expect(page.getByRole('heading', { name: 'Your event is ready.' })).toBeVisible();
  await expect(page.getByText('Management link', { exact: true })).toBeVisible();
  await expect(page.getByText(/cannot be recovered/i)).toBeVisible();
});

test('guest event is usable at desktop and narrow viewports', async ({ page }) => {
  await page.route('**/api/event/maya-theo', (route) => route.fulfill({ json: { data: { event, role: 'guest' }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/gallery', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/contributions', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/messages', (route) => route.fulfill({ json: { data: { items: [] }, requestId: 'r' } }));
  await page.goto('/event/maya-theo');
  await expect(page.getByRole('heading', { name: event.name })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add photos' })).toBeVisible();
  await expect(page.getByLabel('What should we call you?')).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
});

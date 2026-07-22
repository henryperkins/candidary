import { expect, test } from '@playwright/test';

test('public actions and creation fields are keyboard reachable with named landmarks', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Candidary home' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: testInfo.project.name === 'mobile' ? 'Create your event' : 'Create an event' })).toBeFocused();
  await page.goto('/create');
  await expect(page.getByLabel('Event name')).toHaveAttribute('required', '');
  await expect(page.getByLabel('Event date')).toHaveAttribute('type', 'date');
  await expect(page.getByLabel('Welcome message')).toHaveAttribute('maxlength', '500');
});

test('guest photo sources have mobile-sized targets and name errors focus the field', async ({ page }) => {
  await page.route('**/api/event/maya-theo', (route) => route.fulfill({ json: { data: { event: {
    id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Help us remember tonight.',
    uploadsEnabled: true, galleryVisible: false, moderationRequired: true,
  }, role: 'guest' }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/contributions', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/messages', (route) => route.fulfill({ json: { data: { items: [] }, requestId: 'r' } }));
  await page.goto('/event/maya-theo');

  const camera = page.getByRole('button', { name: 'Take a photo', exact: true });
  const library = page.getByRole('button', { name: 'Choose recent photos', exact: true });
  for (const target of [camera, library]) {
    await expect.poll(async () => (await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect.poll(async () => (await target.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await camera.click();
  await expect(page.getByLabel('Your name')).toBeFocused();
  await expect(page.getByText('Enter your name before adding photos.')).toHaveAttribute('role', 'alert');
});

test('manager navigation exposes visible labels, selected state, and mobile-sized targets', async ({ page }) => {
  const event = {
    id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
    uploadsEnabled: true, galleryVisible: false, moderationRequired: true, storedMediaCount: 0, storedBytes: 0,
    guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
  };
  await page.route('**/api/manage/events/event-a', (route) => route.fulfill({ json: { data: { event }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/media*', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/messages', (route) => route.fulfill({ json: { data: { messages: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/exports', (route) => route.fulfill({ json: { data: { exports: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/links', (route) => route.fulfill({ json: { data: { guestLink: 'https://candidary.test/join/guest' }, requestId: 'r' } }));
  await page.goto('/manage/event/event-a');
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();

  const intake = page.getByRole('button', { name: 'Intake', exact: true });
  await expect(intake).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['Intake', 'Gallery', 'Notes', 'Share', 'Settings']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const label = button.locator('.manager-nav__label');
    await expect(label).toBeVisible();
    expect(await label.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(0);
    expect((await label.boundingBox())?.height ?? 0).toBeGreaterThan(0);
  }

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(intake).toHaveAttribute('aria-pressed', 'false');
});

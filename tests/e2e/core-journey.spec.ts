import { expect, test } from '@playwright/test';

const event = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'We would love to see the day through your eyes.', uploadsEnabled: true,
  galleryVisible: false, moderationRequired: true, storedMediaCount: 2, storedBytes: 128,
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

test('guest captures, appends, recovers one failure, and reaches the terminal receipt', async ({ page }) => {
  let batchAttempt = 0;
  await page.route('**/api/event/maya-theo', (route) => route.fulfill({ json: { data: { event, role: 'guest' }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/contributions', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/messages', (route) => route.fulfill({ json: { data: { items: [] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/uploads/batch', async (route) => {
    batchAttempt += 1;
    const payload = route.request().postDataJSON() as { files: Array<{ idempotencyKey: string; mimeType: string }> };
    const items = payload.files.map((file, index) => {
      if (batchAttempt === 1 && index === 1) {
        return { idempotencyKey: file.idempotencyKey, status: 'rejected', error: { code: 'UPLOADS_DISABLED', message: 'Reception dropped out. Try this photo again.' } };
      }
      return {
        idempotencyKey: file.idempotencyKey,
        status: 'accepted',
        media: { id: `media-${file.idempotencyKey}`, mimeType: file.mimeType || 'image/jpeg' },
        uploadUrl: `http://127.0.0.1:4173/direct-upload/${file.idempotencyKey}`,
      };
    });
    await route.fulfill({ status: 201, json: { data: { items }, requestId: 'r' } });
  });
  await page.route('**/direct-upload/*', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/event/maya-theo/uploads/*/finalize', (route) => route.fulfill({ json: { data: { media: { uploadState: 'stored' } }, requestId: 'r' } }));

  await page.goto('/event/maya-theo');
  await expect(page.getByRole('heading', { name: event.welcomeMessage })).toBeVisible();
  await expect(page.getByText(/Maya & Theo/).first()).toBeVisible();
  const takePhoto = page.getByRole('button', { name: 'Take a photo', exact: true });
  const chooseRecent = page.getByRole('button', { name: 'Choose recent photos', exact: true });
  await expect(takePhoto).toBeVisible();
  await expect(chooseRecent).toBeVisible();
  await takePhoto.click();
  await expect(page.getByText('Enter your name before adding photos.')).toBeVisible();
  await expect(page.getByLabel('Your name')).toBeFocused();
  await page.getByLabel('Your name').fill('Taylor Morgan');

  const recentBox = await chooseRecent.boundingBox();
  expect(recentBox && recentBox.y + recentBox.height).toBeLessThanOrEqual(844);
  const cameraInput = page.locator('input[data-photo-source="camera"]');
  const libraryInput = page.locator('input[data-photo-source="library"]');
  await expect(cameraInput).toHaveAttribute('capture', 'environment');
  await expect(libraryInput).toHaveAttribute('multiple', '');
  await cameraInput.setInputFiles({
    name: 'just-taken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('captured-photo'),
  });
  await expect(page.getByText('New')).toBeVisible();
  await libraryInput.setInputFiles({
    name: 'recent.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('recent-photo'),
  });
  await expect(page.getByText('2 photos selected')).toBeVisible();
  expect(batchAttempt).toBe(0);

  await page.getByRole('button', { name: 'Send 2 photos' }).click();
  await expect(page.getByText('Delivered', { exact: true })).toBeVisible();
  await expect(page.getByText('Needs attention', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your 2 photos were sent.' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry 1 photo' }).click();
  await expect(page.getByRole('heading', { name: 'Your 2 photos were sent.' })).toBeVisible();
  await expect(page.getByText(/all done and can close this page/i)).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByText(/Shared gallery/)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('candidary_guest_name'))).toBe('Taylor Morgan');

  await page.reload();
  await expect(page.getByText('Sending as Taylor Morgan')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take a photo', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
});

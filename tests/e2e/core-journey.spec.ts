import { mkdir } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { EVENT_ENTRY_FIXTURE_TOKEN, EVENT_FIXTURE, stubEntryExchange } from './fixtures/routes';
import { measureDocument } from './helpers/geometry';

const event = {
  ...EVENT_FIXTURE,
  galleryVisible: false,
  storedMediaCount: 2,
};

test('host creates an event and receives its permanent entry and management link', async ({ page }, testInfo) => {
  await page.route('**/api/events', (route) => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: {
    event,
    eventLink: `https://candidary.test/join#${'entry-secret-'.repeat(8)}`,
    managementLink: `https://candidary.test/manage/${'manager-secret-'.repeat(8)}`,
    csrfToken: 'csrf-a',
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
  const overflow = await page.locator('.success-layout').evaluate((layout) => {
    const viewportWidth = document.documentElement.clientWidth;
    return Array.from(layout.querySelectorAll<HTMLElement>('*')).flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > viewportWidth + 1)
        ? [{ className: element.className, left: rect.left, right: rect.right }]
        : [];
    });
  });
  expect(overflow).toEqual([]);
  await mkdir('output/playwright/screenshots', { recursive: true });
  await page.screenshot({ path: `output/playwright/screenshots/create-success-${testInfo.project.name}.png`, fullPage: true });
});

test('guest captures, appends, recovers one failure, and reaches the terminal receipt', async ({ page }) => {
  let batchAttempt = 0;
  let finalizeAttempt = 0;
  await page.route('**/api/event/maya-theo', (route) => route.fulfill({ json: { data: { event, role: 'guest' }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/contributions', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/messages*', (route) => route.fulfill({ json: { data: {
    items: [], nextCursor: null, ownUnshared: [], ownUnsharedCount: 0, ownUnsharedNextCursor: null,
  }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/uploads/batch', async (route) => {
    batchAttempt += 1;
    const uploadOrigin = new URL(page.url()).origin;
    const payload = route.request().postDataJSON() as { files: Array<{ idempotencyKey: string; mimeType: string }> };
    const items = payload.files.map((file, index) => {
      if (batchAttempt === 1 && index === 1) {
        return { idempotencyKey: file.idempotencyKey, status: 'rejected', error: { code: 'UPLOADS_DISABLED', message: 'Reception dropped out. Try this photo again.' } };
      }
      return {
        idempotencyKey: file.idempotencyKey,
        status: 'accepted',
        media: { id: `media-${file.idempotencyKey}`, mimeType: file.mimeType || 'image/jpeg' },
        uploadUrl: `${uploadOrigin}/direct-upload/${file.idempotencyKey}`,
      };
    });
    await route.fulfill({ status: 201, json: { data: { items }, requestId: 'r' } });
  });
  await page.route('**/direct-upload/*', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/event/maya-theo/uploads/*/finalize', (route) => {
    finalizeAttempt += 1;
    if (finalizeAttempt === 1) {
      return route.fulfill({ status: 503, json: { code: 'INTERNAL_ERROR', message: 'Confirmation briefly unavailable.', requestId: 'r' } });
    }
    return route.fulfill({ json: { data: { media: { uploadState: 'stored' } }, requestId: 'r' } });
  });

  // The guest arrives the only way a guest ever does: by scanning the printed code.
  const exchanged = await stubEntryExchange(page);
  await page.goto(`/join#${EVENT_ENTRY_FIXTURE_TOKEN}`);
  await expect(page).toHaveURL(/\/event\/maya-theo$/u);
  expect(exchanged).toEqual([EVENT_ENTRY_FIXTURE_TOKEN]);
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
  expect(finalizeAttempt).toBe(2);
  await expect(page.getByRole('heading', { name: 'Your 2 photos were sent.' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry 1 photo' }).click();
  await expect(page.getByRole('heading', { name: 'Your 2 photos were sent.' })).toBeVisible();
  await expect(page.getByText(/all done and can close this page/i)).toBeVisible();
  const guestbookAction = page.getByRole('button', { name: 'Leave a guestbook note' });
  await expect(guestbookAction).toBeVisible();
  await expect(page.locator('.delivery-receipt').getByRole('button')).toHaveCount(1);
  await expect(page.getByText(/Shared gallery/)).toHaveCount(0);
  expect(finalizeAttempt).toBe(3);
  expect(await page.evaluate(() => localStorage.getItem('candidary_guest_name'))).toBe('Taylor Morgan');

  await guestbookAction.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Leave a note for Maya & Theo' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Your note for Maya & Theo' })).not.toBeFocused();
  await expect(page.locator('details.guestbook')).toHaveAttribute('open', '');

  await page.reload();
  await expect(page.getByText('Sending as Taylor Morgan')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take a photo', exact: true })).toBeVisible();
  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

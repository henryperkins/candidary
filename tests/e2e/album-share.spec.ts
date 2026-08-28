import { expect, test, type Page } from '@playwright/test';

import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';

const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;

async function openAlbum(page: Page) {
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await page.locator('.manager-nav nav button').filter({ hasText: 'Gallery' }).click();
  const modes = page.getByRole('group', { name: 'Gallery mode' });
  await modes.getByRole('button', { name: /^Album/u }).click();
  await expect(page.getByRole('heading', { name: 'The order people with the Album link will see' })).toBeVisible();
}

test('consumes a new share fragment on an already-mounted unavailable album', async ({ page }) => {
  const shareToken = 'same-document-id.same-document-secret';
  const rows = makeMedia(1, 'unpublished').map((item) => ({
    ...item,
    caption: 'A newly shared photograph',
  }));
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    album: {
      pickedMediaIds: [rows[0]!.id],
      title: 'The same-document album',
      entries: [{ kind: 'photo', mediaId: rows[0]!.id }],
      shareActive: true,
      shareToken,
    },
  });

  await page.goto('/album');
  await expect(page.getByRole('heading', { name: 'This album is not available.' })).toBeVisible();
  await page.locator('html').evaluate((documentElement) => {
    documentElement.dataset.albumDocument = 'mounted';
  });

  await page.evaluate((token) => {
    window.location.hash = token;
  }, shareToken);

  await expect(page).toHaveURL(/\/album$/u);
  await expect(page.locator('html')).toHaveAttribute('data-album-document', 'mounted');
  await expect(page.getByRole('heading', { name: 'The same-document album' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('The same-document album is ready. 1 photo.');
  expect(await page.content()).not.toContain(shareToken);
});

test('a manager shares, copies, opens, and stops the same fragment album link', async ({ page, context }) => {
  const rows = makeMedia(4, 'published').map((item, index) => ({
    ...item,
    originalFilename: `private-camera-${index + 1}.jpg`,
    caption: ['First dance', 'Dinner toast', 'Night portraits', 'Last song'][index]!,
  }));
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    event: { storedMediaCount: rows.length, storedBytes: 512 },
    album: {
      pickedMediaIds: rows.map(({ id }) => id),
      title: 'Maya & Theo, after dark',
      description: 'The photographs we kept together.',
      coverMediaId: rows[0]!.id,
      entries: [
        { kind: 'photo', mediaId: rows[0]!.id },
        { kind: 'section', id: 'section-dinner', heading: 'Dinner & dancing' },
        { kind: 'photo', mediaId: rows[1]!.id },
        { kind: 'photo', mediaId: rows[2]!.id },
        { kind: 'photo', mediaId: rows[3]!.id },
      ],
      publicPreviewFailures: [rows[2]!.id],
    },
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openAlbum(page);

  let createRequests = 0;
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/album/share`, (route) => {
    if (route.request().method() === 'POST') createRequests += 1;
    return route.fallback();
  });
  const createAction = page.getByRole('button', { name: 'Create Album link' });
  await createAction.click();
  let createDialog = page.getByRole('dialog', { name: 'Create the Album link?' });
  await expect(createDialog.getByText(
    'This link will show 4 photos and 4 published captions to people with the Album link.',
  )).toBeVisible();
  await expect(createDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  expect(createRequests).toBe(0);
  await page.keyboard.press('Escape');
  await expect(createDialog).toHaveCount(0);
  await expect(createAction).toBeFocused();
  expect(createRequests).toBe(0);

  await createAction.click();
  createDialog = page.getByRole('dialog', { name: 'Create the Album link?' });
  await createDialog.getByRole('button', { name: 'Create Album link' }).click();
  expect(createRequests).toBe(1);
  const copyAction = page.getByRole('button', { name: 'Copy Album link' });
  await expect(copyAction).toBeFocused();
  const shareToken = 'album-share-id.album-share-secret';
  expect(await page.content()).not.toContain(shareToken);
  await page.keyboard.press('Shift+Tab');
  const revealAction = page.getByRole('button', { name: 'Reveal Album link' });
  await expect(revealAction).toBeFocused();
  await page.keyboard.press('Enter');
  const shareInput = page.getByRole('textbox', { name: 'Album link' });
  const shareUrl = await shareInput.inputValue();
  expect(shareUrl).toContain('/album#');
  expect(new URL(shareUrl).origin).toBe(new URL(page.url()).origin);
  const hideAction = page.getByRole('button', { name: 'Hide Album link' });
  await expect(hideAction).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(shareInput).toHaveCount(0);
  expect(await page.content()).not.toContain(shareToken);
  await page.keyboard.press('Tab');
  await expect(copyAction).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shareUrl);

  await page.goto(shareUrl);
  await expect(page).toHaveURL(/\/album$/u);
  await expect(page.getByRole('heading', { level: 1, name: 'Maya & Theo, after dark' })).toBeVisible();
  await expect(page.getByText('The photographs we kept together.')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Cover for Maya & Theo, after dark' })).toBeVisible();
  const blocks = page.locator('.public-album__block');
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0).getByRole('img', { name: 'First dance' })).toBeVisible();
  await expect(blocks.nth(1).getByRole('heading', { name: 'Dinner & dancing' })).toBeVisible();
  await expect(blocks.nth(1).getByText('Preview unavailable')).toHaveCount(1);
  await expect(page.getByText('Dinner toast')).toBeVisible();
  await expect(page.locator('.manager-nav, .manager-gallery')).toHaveCount(0);
  await expect(page.getByText('Avery Stone')).toHaveCount(0);
  await expect(page.getByText('private-camera-1.jpg')).toHaveCount(0);

  await openAlbum(page);
  expect(await page.content()).not.toContain(shareToken);
  await page.getByRole('button', { name: 'Reveal Album link' }).click();
  await expect(page.getByRole('textbox', { name: 'Album link' })).toHaveValue(shareUrl);
  let stopRequests = 0;
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/album/share`, (route) => {
    if (route.request().method() === 'DELETE') stopRequests += 1;
    return route.fallback();
  });
  await page.getByRole('button', { name: 'Stop Album link', exact: true }).click();
  let stopDialog = page.getByRole('alertdialog', { name: 'Stop the Album link?' });
  await expect(stopDialog).toBeVisible();
  expect(stopRequests).toBe(0);
  await stopDialog.getByRole('button', { name: 'Keep sharing' }).click();
  await expect(stopDialog).toHaveCount(0);
  expect(stopRequests).toBe(0);
  await expect(page.getByRole('textbox', { name: 'Album link' })).toHaveValue(shareUrl);

  await page.getByRole('button', { name: 'Stop Album link', exact: true }).click();
  stopDialog = page.getByRole('alertdialog', { name: 'Stop the Album link?' });
  await expect(stopDialog).toBeVisible();
  expect(stopRequests).toBe(0);
  await stopDialog.getByRole('button', { name: 'Stop Album link' }).click();
  await expect(page.getByRole('button', { name: 'Create Album link' })).toBeVisible();
  expect(stopRequests).toBe(1);

  await page.goto('/album');
  await expect(page.getByRole('heading', { name: 'This album is not available.' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('This album is not available.');
  await page.goto(shareUrl);
  await expect(page.getByRole('heading', { name: 'This album is not available.' })).toBeVisible();
});

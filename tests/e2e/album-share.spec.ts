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
  await expect(page.getByRole('heading', { name: 'The order guests will see' })).toBeVisible();
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
  const rows = makeMedia(4, 'unpublished').map((item, index) => ({
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

  await page.getByRole('button', { name: 'Share album' }).click();
  const shareCode = page.locator('.album-share__link code');
  await expect(shareCode).toContainText('/album#');
  const shareUrl = (await shareCode.textContent())!;
  expect(new URL(shareUrl).origin).toBe(new URL(page.url()).origin);
  await page.getByRole('button', { name: 'Copy album link' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
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
  await expect(page.locator('.album-share__link code')).toHaveText(shareUrl);
  await page.getByRole('button', { name: 'Stop sharing album' }).click();
  await expect(page.getByRole('button', { name: 'Share album' })).toBeVisible();

  await page.goto('/album');
  await expect(page.getByRole('heading', { name: 'This album is not available.' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('This album is not available.');
  await page.goto(shareUrl);
  await expect(page.getByRole('heading', { name: 'This album is not available.' })).toBeVisible();
});

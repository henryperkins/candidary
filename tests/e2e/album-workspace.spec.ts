import { expect, test, type Page } from '@playwright/test';

import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';

const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;

async function openGallery(page: Page) {
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await page.locator('.manager-nav nav button').filter({ hasText: 'Gallery' }).click();
  await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
}

test('Library adds and removes album picks, then the album export advances from queued to ready', async ({ page }) => {
  const rows = makeMedia(3, 'unpublished');
  const audit = await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    event: { storedMediaCount: rows.length, storedBytes: 384 },
    album: { exportReadyAfterReads: 2 },
  });
  await openGallery(page);

  const modes = page.getByRole('group', { name: 'Gallery mode' });
  await expect(modes.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(
    'Everything delivered privately, newest first. Picking a photo adds it to the album for every host on this event — it does not publish it.',
  )).toBeVisible();
  const picksFilter = page.getByRole('button', { name: 'Album picks' });
  await expect(picksFilter.locator('.lucide-check')).toHaveCount(1);

  await page.getByRole('button', { name: 'Select photos' }).click();
  await page.getByRole('button', { name: 'Select this moment' }).click();
  const tray = page.getByRole('region', { name: 'Album' });
  await expect(tray).toContainText('3 photos selected');
  await expect(tray).toContainText(
    'Adding does not publish anything, and removing keeps the delivered original.',
  );
  await expect(page.getByRole('button', { name: 'Clear this moment' })).toBeEnabled();
  await tray.getByRole('button', { name: 'Add 3 to album' }).click();
  await expect(tray).toHaveCount(0);
  await expect(page.getByText('In album')).toHaveCount(3);
  await expect(page.getByRole('button', {
    name: `Remove ${rows[0]!.caption} from the album`,
  })).toBeVisible();

  await page.getByRole('button', { name: 'Select photos' }).click();
  await page.getByRole('button', {
    name: `Select ${rows[0]!.caption}, from ${rows[0]!.guestName}`,
  }).click();
  await expect(page.getByRole('button', {
    name: `Deselect ${rows[0]!.caption}, from ${rows[0]!.guestName}`,
  })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('region', { name: 'Album' })
    .getByRole('button', { name: 'Remove 1 from album' }).click();
  await expect(page.getByText('In album')).toHaveCount(2);

  await modes.getByRole('button', { name: /^Album \(2\)$/u }).click();
  await expect(page.getByRole('heading', { name: 'The order guests will see' })).toBeVisible();
  await page.getByRole('button', { name: 'Download album photos' }).click();
  const exportState = page.locator('.album-export .export-state');
  await expect(exportState.getByText('Preparing', { exact: true })).toBeVisible();
  expect(audit.album.requests).toContainEqual(expect.objectContaining({
    method: 'POST',
    path: `/api/manage/events/${EVENT_FIXTURE.id}/exports`,
    body: { kind: 'album' },
  }));

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(exportState.getByText('Ready', { exact: true })).toBeVisible();
  await exportState.getByRole('button', { name: 'Get download links' }).click();
  await expect(exportState.getByRole('link', { name: 'Photo manifest' })).toBeVisible();
  await expect(exportState.getByRole('link', { name: 'Photo part 1 of 1' })).toBeVisible();
  await expect(exportState.getByRole('link', { name: /guestbook/i })).toHaveCount(0);
});

test('Shared clears selection by filter and keeps one failed preview and one bulk action local', async ({ page }) => {
  const rows = makeMedia(2, 'unpublished');
  let releaseBulk!: () => void;
  const bulkGate = new Promise<void>((resolve) => { releaseBulk = resolve; });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    event: { storedMediaCount: rows.length },
    album: {
      managerPreviewFailures: [rows[0]!.id],
      bulkPublicationGate: bulkGate,
    },
  });
  await openGallery(page);
  await page.getByRole('button', { name: 'Shared' }).click();

  await expect(page.getByText(
    'Publication is a separate axis from the album. A photo is delivered privately whether or not it is published, and an album pick never publishes anything.',
  )).toBeVisible();
  const shared = page.locator('.gallery-shared');
  await expect(shared.getByText('Preview unavailable')).toHaveCount(1);
  await expect(shared.locator('.intake-photo img')).toHaveCount(1);

  const choice = shared.getByRole('checkbox', { name: `Select ${rows[1]!.caption}` });
  await choice.check();
  await shared.getByRole('button', { name: 'Published', exact: true }).click();
  await expect(choice).not.toBeChecked();
  await expect(shared.getByRole('button', { name: 'Publish selected' })).toBeDisabled();
  await expect(shared.getByRole('button', { name: 'Hide selected' })).toBeDisabled();

  await shared.getByRole('button', { name: 'Unpublished', exact: true }).click();
  await choice.check();
  await shared.getByRole('button', { name: 'Publish selected' }).click();
  await expect(shared.getByRole('button', { name: 'Publishing…' })).toBeDisabled();
  await expect(shared.getByRole('button', { name: 'Publishing…' })).toHaveAttribute('aria-busy', 'true');
  await expect(shared.getByRole('button', { name: 'Hide selected' })).toBeDisabled();
  await expect(shared.getByRole('button', { name: 'Hiding…' })).toHaveCount(0);
  await expect(shared.locator('.bulk-bar')).toHaveAttribute('aria-busy', 'true');

  releaseBulk();
  await expect(shared.getByRole('button', { name: 'Publish selected' })).toBeDisabled();
});

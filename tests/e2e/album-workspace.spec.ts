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

test('Library adds and removes Album picks, then its export stays visible from queued through running to ready', async ({ page }) => {
  const rows = makeMedia(3, 'unpublished');
  const audit = await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    event: { storedMediaCount: rows.length, storedBytes: 384 },
    album: { exportReadyAfterReads: 3 },
  });
  await openGallery(page);

  const modes = page.getByRole('group', { name: 'Gallery mode' });
  await expect(modes.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(
    'Delivered photos stay private to hosts. Picking changes Album membership and a live Album link; it never publishes to the Guest gallery.',
  )).toBeVisible();
  const picksFilter = page.getByRole('button', { name: 'Album picks' });
  await expect(picksFilter.locator('.lucide-check')).toHaveCount(1);

  await page.getByRole('button', { name: 'Select photos' }).click();
  await page.getByRole('button', { name: 'Select this moment' }).click();
  const tray = page.getByRole('region', { name: 'Album' });
  await expect(tray).toContainText('3 of 50 selected');
  await expect(tray).toContainText(
    'Pick changes Album membership only. Remove from Album keeps every delivered photo in Library; neither action publishes to the Guest gallery.',
  );
  await expect(page.getByRole('button', { name: 'Clear this moment' })).toBeEnabled();
  await tray.getByRole('button', { name: 'Pick for Album (3)' }).click();
  await expect(tray).toHaveCount(0);
  await expect(page.getByText('In Album')).toHaveCount(3);
  await expect(page.getByRole('button', {
    name: `Remove ${rows[0]!.caption} from Album`,
  })).toBeVisible();

  await page.getByRole('button', { name: 'Select photos' }).click();
  await page.getByRole('button', {
    name: `Select ${rows[0]!.caption}, from ${rows[0]!.guestName}`,
  }).click();
  await expect(page.getByRole('button', {
    name: `Deselect ${rows[0]!.caption}, from ${rows[0]!.guestName}`,
  })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('region', { name: 'Album' })
    .getByRole('button', { name: 'Remove from Album (1)' }).click();
  await expect(page.getByText('In Album')).toHaveCount(2);

  await modes.getByRole('button', { name: /^Album \(2\)$/u }).click();
  await expect(page.getByRole('heading', { name: 'The order people with the Album link will see' })).toBeVisible();
  await page.getByRole('button', { name: 'Download album photos' }).click();
  const exportState = page.locator('.album-export .export-state');
  await expect(exportState.getByText('Queued', { exact: true })).toBeVisible();
  await expect(exportState).toContainText('Waiting to start.');
  expect(audit.album.requests).toContainEqual(expect.objectContaining({
    method: 'POST',
    path: `/api/manage/events/${EVENT_FIXTURE.id}/exports`,
    body: { kind: 'album' },
  }));

  const liveHost = page.locator('[data-gallery-live-host="true"]');
  await expect(liveHost).toHaveCount(1);
  await expect(liveHost.getByRole('status')).toHaveCount(1);
  await expect(liveHost.getByRole('status')).toContainText('Queued');
  expect(await liveHost.evaluate((element) => element.parentElement === document.body),
    'the one persistent live owner is scoped outside the Manager shell').toBe(true);

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(exportState.getByText('Running', { exact: true })).toBeVisible();
  await expect(exportState).toContainText('Progress: 1 of 2 photos');
  await expect(liveHost.getByRole('status')).toContainText('Running');

  await page.locator('.manager-nav nav button').filter({ hasText: 'Intake' }).click();
  const compact = page.getByRole('region', { name: 'Export progress' });
  await expect(compact).toContainText('Album export · Running');
  await expect(compact).toContainText('1 of 2 photos processed');
  await expect(page.locator('[data-gallery-live-host="true"]')).toHaveCount(1);

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(compact).toHaveCount(0);
  await expect(liveHost.getByRole('status')).toContainText('Ready');

  await page.locator('.manager-nav nav button').filter({ hasText: 'Gallery' }).click();
  await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Album \(2\)$/u }).click();
  await expect(exportState.getByText('Ready', { exact: true })).toBeVisible();
  await exportState.getByRole('button', { name: 'Get download links' }).click();
  await expect(exportState.getByRole('link', { name: 'Photo manifest' })).toBeVisible();
  await expect(exportState.getByRole('link', { name: 'Photo part 1 of 1' })).toBeVisible();
  await expect(exportState.getByRole('link', { name: /guestbook/i })).toHaveCount(0);
});

test('Guest gallery clears selection by filter and keeps one failed preview and one bulk action local', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Guest gallery' }).click();

  await expect(page.getByText(
    'Publish and Hide change what event guests see. They do not change Album membership or the Album link.',
  )).toBeVisible();
  const shared = page.locator('.gallery-shared');
  await expect(shared.getByText('Preview unavailable')).toHaveCount(1);
  await expect(shared.locator('.intake-photo img')).toHaveCount(1);
  await expect(shared.getByRole('button', { name: `Publish ${rows[0]!.originalFilename}` }))
    .toHaveCSS('background-color', 'rgb(104, 118, 61)');
  const secondaryHide = shared.getByRole('button', { name: `Hide ${rows[0]!.originalFilename}` });
  await expect(secondaryHide).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(secondaryHide).toHaveCSS('border-top-color', 'rgb(74, 36, 21)');

  const choice = shared.getByRole('checkbox', { name: `Select ${rows[1]!.caption}` });
  await choice.check();
  await shared.getByRole('button', { name: 'Published', exact: true }).click();
  await expect(choice).not.toBeChecked();
  await expect(page.locator('[data-gallery-live-host] [role="status"]')).toHaveText('Selection cleared.');
  await expect(shared.getByRole('button', { name: 'Publish selected' })).toBeDisabled();
  await expect(shared.getByRole('button', { name: 'Hide selected' })).toBeDisabled();

  await shared.getByRole('button', { name: 'Unpublished', exact: true }).click();
  await shared.getByRole('checkbox', { name: `Select ${rows[0]!.caption}` }).check();
  await choice.check();
  await shared.getByRole('button', { name: 'Publish selected' }).click();
  await expect(shared.getByRole('button', { name: 'Publishing…' })).toBeDisabled();
  await expect(shared.getByRole('button', { name: 'Publishing…' })).toHaveAttribute('aria-busy', 'true');
  await expect(shared.getByRole('button', { name: 'Hide selected' })).toBeDisabled();
  await expect(shared.getByRole('button', { name: 'Hiding…' })).toHaveCount(0);
  await expect(shared.locator('.bulk-bar')).toHaveAttribute('aria-busy', 'true');

  releaseBulk();
  await expect(shared.getByRole('button', { name: 'Publish selected' })).toBeDisabled();
  await expect(page.locator('[data-gallery-live-host] [role="status"]')).toHaveText(
    '2 photos are Published in the Guest gallery for event guests. Hide them to reverse this.',
  );
  await expect(page.locator('[data-gallery-live-host] [role="status"]')).not.toHaveText('Publishing finished.');
  await shared.getByRole('button', { name: 'Published', exact: true }).click();
  await expect(shared.getByRole('button', { name: `Hide ${rows[0]!.originalFilename}` }))
    .toHaveCSS('background-color', 'rgb(74, 36, 21)');
});

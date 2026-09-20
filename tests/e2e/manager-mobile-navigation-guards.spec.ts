import { expect, test, type Page } from '@playwright/test';

import { EVENT_FIXTURE, stubLibraryRoutes, stubManagerRoutes } from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';

const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;

async function chooseSettings(page: Page, current: 'RSVP' | 'Gallery') {
  const toggle = page.getByRole('button', { name: new RegExp(`^${current}, open navigation`) });
  await toggle.click();
  const navigation = page.getByRole('navigation', { name: 'Manager sections' });
  await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
}

test('mobile section menu preserves the RSVP draft on Stay and opens Settings only after discard', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto(`${managerUrl}?section=rsvp`);
  await page.getByRole('button', { name: 'Add guests', exact: true }).click();
  const source = page.getByLabel('Guest names or spreadsheet data');
  await source.fill('Avery Lee\nJordan Lee');

  await chooseSettings(page, 'RSVP');
  const prompt = page.getByRole('region', { name: 'Your pending work is not saved' });
  await expect(prompt).toBeFocused();
  await expect(page).toHaveURL(`${managerUrl}?section=rsvp`);
  await prompt.getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(source).toHaveValue('Avery Lee\nJordan Lee');

  await chooseSettings(page, 'RSVP');
  await expect(prompt).toBeFocused();
  await prompt.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(page).toHaveURL(`${managerUrl}?section=settings`);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Settings, open navigation/ })).toBeVisible();
  await expect(source).toHaveCount(0);
});

test('mobile section menu preserves invalid Album edits on Stay and opens Settings only after discard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rows = makeMedia(2, 'published');
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    event: { storedMediaCount: rows.length },
    album: {
      pickedMediaIds: rows.map(({ id }) => id),
      title: 'Our Album',
      entries: rows.map(({ id }) => ({ kind: 'photo' as const, mediaId: id })),
      saved: true,
    },
  });
  await page.goto(`${managerUrl}?section=gallery&mode=album`);
  await page.getByRole('button', { name: 'Album settings', exact: true }).click();
  const title = page.getByLabel('Album title');
  await title.fill('');
  await expect(title).toHaveAttribute('aria-invalid', 'true');

  await chooseSettings(page, 'Gallery');
  const prompt = page.getByRole('region', { name: 'Album changes are not saved yet' });
  await expect(prompt).toBeFocused();
  await expect(prompt.getByRole('status')).toHaveText('Album title needs attention before the Album can be confirmed.');
  await expect(page).toHaveURL(`${managerUrl}?section=gallery&mode=album`);
  await prompt.getByRole('button', { name: 'Stay in Album', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(title).toHaveValue('');
  await expect(title).toBeFocused();

  await chooseSettings(page, 'Gallery');
  await expect(prompt).toBeFocused();
  await prompt.getByRole('button', { name: 'Discard unsent Album changes and leave', exact: true }).click();
  await expect(page).toHaveURL(`${managerUrl}?section=settings`);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Settings, open navigation/ })).toBeVisible();
});

test('mobile section menu stays above Library popovers and selection Undo while the viewer owns modal focus', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await stubLibraryRoutes(page, 3);
  await page.goto(managerUrl);
  const photos = page.locator('.gallery-private [data-photo-id]');
  await expect(photos).toHaveCount(3);
  const toggle = page.locator('.manager-nav__toggle');
  const navigation = page.getByRole('navigation', { name: 'Manager sections' });

  async function expectMenuAboveContent(label: string) {
    await toggle.click();
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole('button')).toHaveCount(5);
    const blockedButtons = await navigation.getByRole('button').evaluateAll(buttons => buttons.flatMap(button => {
      const box = button.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const hits = [box.top + 4, box.top + box.height / 2, box.bottom - 4]
        .map(y => document.elementFromPoint(x, y));
      return hits.every(hit => hit !== null && button.contains(hit)) ? [] : [button.textContent?.trim()];
    }));
    expect(blockedButtons, `${label}: every destination receives pointer input`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${label}-menu.png`) });
    await navigation.getByRole('button', { name: 'Gallery', exact: true }).click();
    await expect(navigation).toBeHidden();
  }

  for (const [label, root, body] of [
    ['event-details', '.library-event-details', '.library-event-details__body'],
    ['exports', '.gallery-export-tools', '.gallery-export-tools__body'],
  ] as const) {
    const disclosure = page.locator(root);
    await disclosure.locator(':scope > summary').click();
    await expect(page.locator(body)).toBeVisible();
    await expectMenuAboveContent(label);
    if (await disclosure.getAttribute('open') !== null) {
      await disclosure.locator(':scope > summary').click();
    }
  }

  // Opening a real viewer after closing the menu must inert the header and paint over it.
  await photos.first().locator('.gallery-mosaic__open').click();
  const viewer = page.getByRole('dialog');
  await expect(viewer.getByRole('button', { name: 'Close viewer', exact: true })).toBeFocused();
  expect(await toggle.evaluate(button => button.closest('[inert]') !== null)).toBe(true);
  expect(await toggle.evaluate(button => {
    const box = button.getBoundingClientRect();
    return Boolean(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      ?.closest('.gallery-viewer'));
  })).toBe(true);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // A confirmed deletion supplies the real retained Undo offer; selecting another photo
  // adds the Library tray, exercising the portal and shell layers together.
  await viewer.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await viewer.getByRole('button', { name: 'Keep photo', exact: true }).waitFor();
  await viewer.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeVisible();
  await viewer.getByRole('button', { name: 'Close viewer', exact: true }).click();
  await expect(photos).toHaveCount(2);
  await page.getByRole('button', { name: 'Select photos', exact: true }).click();
  await photos.first().locator('.gallery-mosaic__open').click();
  await expect(page.locator('.selection-tray')).toBeVisible();
  await expect(undo).toBeVisible();
  await expectMenuAboveContent('selection-and-undo');
  await expect(page.locator('.selection-tray')).toBeVisible();
  await expect(undo).toBeVisible();
});

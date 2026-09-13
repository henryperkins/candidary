import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';
import { settleRendering } from './helpers/rendering';

const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;
const galleryUrl = `${managerUrl}?section=gallery`;
const reviewDirectory = resolve(process.cwd(), '.impeccable', 'review');

function albumRows() {
  const dates = [
    '2026-09-12T22:45:00.000Z',
    '2026-09-12T20:15:00.000Z',
    '2026-09-12T22:40:00.000Z',
    '2026-09-12T19:20:00.000Z',
    '2026-09-12T21:10:00.000Z',
    '2026-09-12T18:00:00.000Z',
  ];
  const guests = ['Wren Alcott', 'Priya Raman', 'Tomas Okafor', 'Maeve Lindqvist', 'Taylor Morgan', 'Jordan Lee'];
  const captions = [
    'The vows, from the third row',
    'Confetti at the top of the stairs',
    'Grandma Ruth found the cake',
    'First dance, second song',
    'A table full of happy tears',
    'The last song before midnight',
  ];

  return makeMedia(6, 'unpublished').map((row, index) => ({
    ...row,
    createdAt: dates[index]!,
    guestName: guests[index]!,
    caption: captions[index]!,
    originalFilename: `IMG_${4800 + index * 7}.HEIC`,
  }));
}

async function openSavedAlbum(page: Page) {
  const rows = albumRows();
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    event: { storedMediaCount: rows.length, storedBytes: rows.length * 3_200_000 },
    album: {
      title: 'Maya & Theo — The Album',
      description: 'The photographs we want to keep together, in the order the night happened.',
      coverMediaId: rows[0]!.id,
      entries: [
        { kind: 'photo', mediaId: rows[1]!.id },
        { kind: 'photo', mediaId: rows[0]!.id },
        { kind: 'section', id: 'reception', heading: 'Reception' },
        { kind: 'photo', mediaId: rows[3]!.id },
        { kind: 'photo', mediaId: rows[2]!.id },
        { kind: 'photo', mediaId: rows[5]!.id },
        { kind: 'photo', mediaId: rows[4]!.id },
      ],
      saved: true,
    },
  });

  await page.goto(galleryUrl);
  await expect(page.getByRole('group', { name: 'Gallery mode' })).toBeVisible();
  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Album/u }).click();
  await expect(page.getByRole('heading', { name: 'Album', exact: true })).toBeVisible();
  return rows;
}

async function expectContained(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function expectMinimumTargetSize(page: Page) {
  const targets = page.locator([
    '.album-organizer input',
    '.album-organizer select',
    '.album-delivery button',
    '.album-review-grid button:visible',
  ].join(','));
  for (let index = 0; index < await targets.count(); index += 1) {
    const target = targets.nth(index);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    expect(box?.height, `Album organizer target ${index + 1} height`).toBeGreaterThanOrEqual(44);
  }
}

async function capture(page: Page, testInfo: TestInfo, name: 'organizer' | 'delivery') {
  await mkdir(reviewDirectory, { recursive: true });
  await settleRendering(page, { parkPointer: true });
  await expect.poll(() => page.locator('.album-review-grid img').evaluateAll(images =>
    images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
  )).toBe(true);
  await page.locator('.album-review-grid img').last().scrollIntoViewIfNeeded();
  await page.locator('.album-review-grid img').evaluateAll(images => Promise.all(
    images.map(image => (image as HTMLImageElement).decode()),
  ));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await settleRendering(page, { parkPointer: true });
  await page.screenshot({
    path: resolve(reviewDirectory, `album-surface-2026-09-13-${testInfo.project.name}-${name}.png`),
    fullPage: true,
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      $RefreshReg$: () => undefined,
      $RefreshSig$: () => (type: unknown) => type,
    });
  });
});

test('organizes a saved Album before delivery without horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize(testInfo.project.name === 'mobile'
    ? { width: 390, height: 844 }
    : { width: 1440, height: 1000 });
  const rows = await openSavedAlbum(page);
  const organizer = page.locator('.album-organizer');
  const entries = page.locator('.album-review-grid > [data-entry-key]');

  await organizer.scrollIntoViewIfNeeded();
  await expect(organizer).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Filter Album photos' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sort Album order' })).toHaveValue('manual');
  await capture(page, testInfo, 'organizer');

  await page.getByRole('searchbox', { name: 'Filter Album photos' }).fill('Tomas');
  await expect(page.locator(`[data-entry-key="photo:${rows[2]!.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-entry-key="photo:${rows[0]!.id}"]`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear Album filter' })).toHaveCSS('min-width', '44px');
  await page.getByRole('button', { name: 'Clear Album filter' }).click();

  await page.getByRole('combobox', { name: 'Sort Album order' }).selectOption('newest');
  await expect.poll(async () => entries.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-entry-key'))))
    .toEqual([
      `photo:${rows[0]!.id}`,
      `photo:${rows[1]!.id}`,
      'section:reception',
      `photo:${rows[2]!.id}`,
      `photo:${rows[4]!.id}`,
      `photo:${rows[3]!.id}`,
      `photo:${rows[5]!.id}`,
    ]);
  await expect(page.getByRole('button', { name: /^Move .* later$/u }).first()).toBeDisabled();

  await page.getByRole('combobox', { name: 'Sort Album order' }).selectOption('manual');
  const firstKey = await entries.first().getAttribute('data-entry-key');
  const secondKey = await entries.nth(1).getAttribute('data-entry-key');
  if (testInfo.project.name === 'desktop') {
    await entries.first().dragTo(entries.nth(1));
  } else {
    const handle = await entries.first().getByRole('button', { name: /^Reorder /u }).boundingBox();
    const target = await entries.nth(1).locator('.album-review-grid__preview').boundingBox();
    expect(handle).not.toBeNull();
    expect(target).not.toBeNull();
    const client = await page.context().newCDPSession(page);
    const start = { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 };
    const end = { x: target!.x + target!.width / 2, y: target!.y + target!.height / 2 };
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (let step = 1; step <= 6; step += 1) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: start.x + (end.x - start.x) * step / 6, y: start.y + (end.y - start.y) * step / 6,
      }] });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await client.detach();
  }
  await expect(entries.first()).toHaveAttribute('data-entry-key', secondKey!);
  await expect(entries.nth(1)).toHaveAttribute('data-entry-key', firstKey!);
  await entries.first().getByRole('button', { name: /^Reorder /u }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(entries.first()).toHaveAttribute('data-entry-key', firstKey!);
  await expect(entries.nth(1).getByRole('button', { name: /^Reorder /u })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(entries.first()).toHaveAttribute('data-entry-key', secondKey!);
  await page.keyboard.press('ArrowRight');
  await expect(entries.first()).toHaveAttribute('data-entry-key', firstKey!);

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  for (const destination of ['OneDrive', 'Google Photos', 'iCloud']) {
    await expect(page.getByRole('button', { name: `${destination} Coming soon` })).toBeDisabled();
  }
  await expect(page.getByText(/Connected ·/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download Album' })).toBeEnabled();
  await expectMinimumTargetSize(page);
  await expectContained(page);
  const dismissUndo = page.getByRole('button', { name: 'Dismiss' });
  if (await dismissUndo.isVisible()) await dismissUndo.click();
  await page.getByRole('button', { name: 'Download Album' }).scrollIntoViewIfNeeded();
  await capture(page, testInfo, 'delivery');

  const exportRequest = page.waitForRequest(request => request.url().endsWith('/exports') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Download Album' }).click();
  expect((await exportRequest).postDataJSON()).toMatchObject({ kind: 'album' });
  await expect(page.getByRole('heading', { name: 'Album download', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View progress' })).toBeVisible();

  if (testInfo.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 844 });
    await expectContained(page);
    const controlsFit = await page.locator('.album-review-grid__photo').evaluateAll(cards => cards.every(card => {
      const bounds = card.getBoundingClientRect();
      return Array.from(card.querySelectorAll('button')).filter(button => button.getClientRects().length > 0).every(button => {
        const rect = button.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      });
    }));
    expect(controlsFit).toBe(true);
    await page.getByRole('button', { name: 'Close album download' }).click();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await settleRendering(page, { parkPointer: true });
    await page.screenshot({ path: resolve(reviewDirectory, 'album-surface-2026-09-13-320.png'), fullPage: true });
  }
});

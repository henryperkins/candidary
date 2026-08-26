import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';
import { measureDocument, measureTarget } from './helpers/geometry';
import { settleRendering } from './helpers/rendering';

const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;
const AXE_OPTIONS = { rules: { 'target-size': { enabled: true } } };

function albumRows() {
  return makeMedia(12, 'unpublished').map((row, index) => ({
    ...row,
    guestName: ['Priya Raman', 'Wren Alcott', 'Tomas Okafor', 'Maeve Lindqvist'][index % 4]!,
    caption: [
      'The vows, from the third row',
      'Confetti at the top of the stairs',
      'Grandma Ruth found the cake',
      'First dance, second song',
    ][index % 4]!,
    originalFilename: `IMG_${4800 + index * 7}.HEIC`,
    createdAt: new Date(index < 4
      ? Date.UTC(2026, 8, 12, 23, 20 + index * 4)
      : Date.UTC(2026, 8, 12, 19, 20 + (index - 4) * 4)).toISOString(),
  }));
}

function populatedEntries(rows: ReturnType<typeof albumRows>) {
  return [
    { kind: 'photo' as const, mediaId: rows[0]!.id },
    { kind: 'photo' as const, mediaId: rows[1]!.id },
    { kind: 'section' as const, id: 'section-reception', heading: 'Reception' },
    { kind: 'photo' as const, mediaId: rows[2]!.id },
    { kind: 'photo' as const, mediaId: rows[3]!.id },
  ];
}

async function stubAlbumWorkspace(page: Page, { saved = false, shareActive = false } = {}) {
  const rows = albumRows();
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    event: { storedMediaCount: rows.length, storedBytes: rows.length * 3_200_000 },
    album: {
      pickedMediaIds: rows.slice(0, 10).map(({ id }) => id),
      title: 'The evening',
      description: 'The photographs we want to keep together, in the order the night happened.',
      coverMediaId: rows[0]!.id,
      entries: saved ? populatedEntries(rows) : undefined,
      saved,
      shareActive,
    },
  });
  return rows;
}

async function openGallery(page: Page) {
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await page.locator('.manager-nav nav button').filter({ hasText: 'Gallery' }).click();
  await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
}

async function parkAtTop(page: Page) {
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
  });
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  // `:visible` includes lazy images far below the viewport. Waiting on their
  // decode would deadlock the capture because the browser has correctly chosen
  // not to fetch them. Only the pixels this viewport can paint must be ready.
  await page.waitForFunction(() => Array.from(document.images).every((image) => {
    const bounds = image.getBoundingClientRect();
    const intersectsViewport = bounds.bottom > 0
      && bounds.right > 0
      && bounds.top < window.innerHeight
      && bounds.left < window.innerWidth;
    return !intersectsViewport || image.complete;
  }));
  await settleRendering(page, { parkPointer: true });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
}

async function selectFirstMoment(page: Page) {
  await page.getByRole('button', { name: 'Select photos' }).click();
  await page.getByRole('button', { name: 'Select this moment' }).first().click();
  await expect(page.getByRole('region', { name: 'Album' })).toContainText('4 of 50 selected');
}

async function openAlbumFromPicks(page: Page) {
  const modes = page.getByRole('group', { name: 'Gallery mode' });
  await modes.getByRole('button', { name: /^Album/u }).click();
  await expect(page.getByText('10 photos were picked before this Album existed.')).toBeVisible();
}

async function startAlbum(page: Page) {
  await page.getByRole('button', { name: 'Start the Album from them' }).click();
  await expect(page.getByRole('heading', { name: 'The order people with the Album link will see' })).toBeVisible();
  await expect(page.getByText('10 photos In Album')).toBeVisible();
}

async function expectAxeClean(page: Page, state: string) {
  const results = await new AxeBuilder({ page }).options(AXE_OPTIONS).analyze();
  expect(results.violations, `${state} axe violations:\n${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
}

async function expectContained(page: Page, state: string) {
  const size = await measureDocument(page);
  expect(size.scrollWidth, `${state} horizontal overflow`).toBeLessThanOrEqual(size.clientWidth + 1);
}

async function expectTargetsAtLeast44(locator: Locator, state: string) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const target = locator.nth(index);
    if (!await target.isVisible()) continue;
    const { width, height } = await measureTarget(target);
    expect(width, `${state} target ${index + 1} width`).toBeGreaterThanOrEqual(44);
    expect(height, `${state} target ${index + 1} height`).toBeGreaterThanOrEqual(44);
  }
}

function desktopOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop evidence is captured once in the desktop project.');
}

function mobileOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile evidence is captured once in the mobile project.');
}

test('captures the seven handoff-aligned manager states at 924 by 540', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.slow();
  await page.setViewportSize({ width: 924, height: 540 });
  await stubAlbumWorkspace(page);
  await openGallery(page);

  await parkAtTop(page);
  await capture(page, testInfo, 'desktop-01-library');

  await selectFirstMoment(page);
  await parkAtTop(page);
  await capture(page, testInfo, 'desktop-02-selection');

  await openAlbumFromPicks(page);
  await parkAtTop(page);
  await capture(page, testInfo, 'desktop-03-reconciliation');

  await startAlbum(page);
  await page.locator('.album-metadata').evaluate((element) => {
    const top = element.getBoundingClientRect().top + window.scrollY - 16;
    window.scrollTo(0, top);
  });
  await capture(page, testInfo, 'desktop-04-editor-details');

  await parkAtTop(page);
  await capture(page, testInfo, 'desktop-05-editor');

  await page.getByRole('button', { name: 'Preview album' }).click();
  await expect(page.getByText('What people with the Album link see')).toBeVisible();
  await parkAtTop(page);
  await capture(page, testInfo, 'desktop-06-preview');

  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Guest gallery/u }).click();
  await expect(page.getByText('Published photos are visible to event guests.')).toBeVisible();
  await parkAtTop(page);
  await capture(page, testInfo, 'desktop-07-shared');
});

test('captures and audits the mobile manager states at 390 by 844', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await stubAlbumWorkspace(page);
  await openGallery(page);

  const managerTargets = page.locator([
    '.manager-nav .brand',
    '.manager-nav button',
    '.manager-main button',
    '.manager-main input:not([type="checkbox"])',
    '.manager-main textarea',
    '.manager-main .intake-select',
  ].join(','));

  await parkAtTop(page);
  await expectAxeClean(page, 'mobile Library');
  await expectContained(page, 'mobile Library');
  await expectTargetsAtLeast44(managerTargets, 'mobile Library');
  await capture(page, testInfo, 'mobile-01-library');

  await selectFirstMoment(page);
  await parkAtTop(page);
  await expectAxeClean(page, 'mobile selection');
  await expectContained(page, 'mobile selection');
  await expectTargetsAtLeast44(managerTargets, 'mobile selection');
  await capture(page, testInfo, 'mobile-02-selection');

  await openAlbumFromPicks(page);
  await startAlbum(page);
  await parkAtTop(page);
  await expectAxeClean(page, 'mobile editor');
  await expectContained(page, 'mobile editor');
  await expectTargetsAtLeast44(managerTargets, 'mobile editor');
  await capture(page, testInfo, 'mobile-03-editor');

  await page.getByRole('button', { name: 'Preview album' }).click();
  await expect(page.getByText('What people with the Album link see')).toBeVisible();
  await parkAtTop(page);
  await expectAxeClean(page, 'mobile preview');
  await expectContained(page, 'mobile preview');
  await expectTargetsAtLeast44(managerTargets, 'mobile preview');
  await capture(page, testInfo, 'mobile-04-preview');

  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Guest gallery/u }).click();
  await parkAtTop(page);
  await expectAxeClean(page, 'mobile Shared');
  await expectContained(page, 'mobile Shared');
  await expectTargetsAtLeast44(managerTargets, 'mobile Shared');
  await capture(page, testInfo, 'mobile-05-shared');
});

test('captures and audits the public album at 390 by 844', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  const rows = await stubAlbumWorkspace(page, { saved: true, shareActive: true });

  await page.goto('/album#album-share-id.album-share-secret');
  await expect(page).toHaveURL(/\/album$/u);
  await expect(page.getByRole('heading', { level: 1, name: 'The evening' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reception' })).toBeVisible();
  await expect(page.getByRole('img', { name: `Cover for The evening` })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Album photo 1' }).first()).toBeVisible();
  await expect(page.getByText(rows[0]!.caption)).toHaveCount(0);
  await expectAxeClean(page, 'mobile public album');
  await expectContained(page, 'mobile public album');
  await capture(page, testInfo, 'mobile-06-public');
});

test('album mode is keyboard-operable and respects reduced motion', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 924, height: 540 });
  await stubAlbumWorkspace(page);
  await openGallery(page);

  const albumMode = page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Album/u });
  await albumMode.focus();
  await page.keyboard.press('Enter');
  await expect(albumMode).toHaveAttribute('aria-pressed', 'true');

  const start = page.getByRole('button', { name: 'Start the Album from them' });
  await start.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'The order people with the Album link will see' })).toBeVisible();

  const firstEntry = page.locator('.album-review-grid > li').first();
  const firstEntryName = (await firstEntry.locator('.album-review-grid__meta strong').textContent())!;
  const moveLater = firstEntry.getByRole('button', { name: `Move ${firstEntryName} later` });
  await moveLater.focus();
  await page.keyboard.press('Enter');
  const movedEntry = page.locator('.album-review-grid > li').nth(1);
  await expect(movedEntry.locator('.album-review-grid__meta strong')).toHaveText(firstEntryName);
  const galleryAnnouncement = page.locator('[data-gallery-live-host="true"] [role="status"]');
  await expect(galleryAnnouncement).toHaveText('Moved to position 2 of 10.');
  await expect(galleryAnnouncement).toHaveAttribute('role', 'status');
  await expect(galleryAnnouncement).toHaveAttribute('aria-live', 'polite');
  await expect(galleryAnnouncement).toHaveAttribute('aria-atomic', 'true');
  await expect(movedEntry.getByRole('button', { name: `Move ${firstEntryName} earlier` })).toBeFocused();

  const preview = page.getByRole('button', { name: 'Preview album' });
  await preview.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('What people with the Album link see')).toBeVisible();
  const backToEditing = page.getByRole('button', { name: 'Back to editing' });
  await expect(backToEditing).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Album title')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview album' })).toBeFocused();

  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: 'Library' }).click();
  await selectFirstMoment(page);
  const tray = page.getByRole('region', { name: 'Album' });
  await expect(tray).toBeVisible();
  expect(await tray.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
});

test('manager album reflows at 200 and 400 percent zoom proxies', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await stubAlbumWorkspace(page, { saved: true, shareActive: true });
  await openGallery(page);
  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Album/u }).click();
  await expect(page.getByRole('heading', { name: 'The order people with the Album link will see' })).toBeVisible();

  for (const viewport of [
    { width: 640, height: 450, label: '200 percent' },
    { width: 320, height: 450, label: '400 percent' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await parkAtTop(page);

    const operableControls = [
      page.getByRole('group', { name: 'Gallery mode' }).getByRole('button', { name: /^Album/u }),
      page.getByLabel('Album title'),
      page.getByLabel('Description'),
      page.getByRole('button', { name: /^Move .* later$/u }).first(),
      page.getByRole('button', { name: 'Stop Album link' }),
      page.getByRole('button', { name: 'Reveal Album link' }),
      page.getByRole('button', { name: 'Copy Album link' }),
      page.getByRole('button', { name: 'Download album photos' }),
    ];
    for (const control of operableControls) {
      await control.scrollIntoViewIfNeeded();
      await expect(control, `${viewport.label} control`).toBeVisible();
      await expect(control, `${viewport.label} control`).toBeEnabled();
      await control.focus();
      await expect(control, `${viewport.label} control`).toBeFocused();
    }
    await expectContained(page, viewport.label);

    const reveal = page.getByRole('button', { name: 'Reveal Album link' });
    await expectTargetsAtLeast44(page.getByRole('button', {
      name: /^(Reveal Album link|Copy Album link|Stop Album link)$/u,
    }), `${viewport.label} masked Album-link controls`);
    await reveal.click();
    const linkField = page.getByRole('textbox', { name: 'Album link' });
    await expect(linkField).toHaveCount(1);
    await expect(linkField).toHaveAttribute('readonly', '');
    await expectContained(page, `${viewport.label} revealed Album link`);
    await expectTargetsAtLeast44(page.getByRole('button', {
      name: /^(Hide Album link|Copy Album link|Stop Album link)$/u,
    }), `${viewport.label} revealed Album-link controls`);
    await page.getByRole('button', { name: 'Hide Album link' }).click();
    await expect(linkField).toHaveCount(0);
    await expectContained(page, `${viewport.label} remasked Album link`);
  }
});

test('Album-link creation dialog stays operable and contained at 320 pixels', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.setViewportSize({ width: 320, height: 450 });
  await stubAlbumWorkspace(page, { saved: true });
  await openGallery(page);
  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Album/u }).click();

  const createAction = page.getByRole('button', { name: 'Create Album link' });
  await createAction.click();
  const dialog = page.getByRole('dialog', { name: 'Create the Album link?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectTargetsAtLeast44(dialog.getByRole('button'), '320px Album-link creation dialog');
  await expectContained(page, '320px Album-link creation dialog');

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(createAction).toBeFocused();
});

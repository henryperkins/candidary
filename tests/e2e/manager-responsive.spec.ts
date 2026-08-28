import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { MANAGER_MEDIA_PAGE_SIZE, MAX_EVENT_BYTES, MAX_EVENT_MEDIA } from '../../shared/constants';
import type { ManagerGuestbookItem } from '../../shared/contracts';
import type { ExportView } from '../../src/app/types';
import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { LONG_FILENAME, UNBROKEN_NOTE, makeMedia } from './fixtures/ui-data';
import {
  boxesIntersect,
  measureContrast,
  measureDocument,
  measureFoldBelowObstructions,
  measureGridTracks,
  measureOverflow,
  measureSeparation,
  measureTarget,
  measureViewportEscapes,
} from './helpers/geometry';

const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;
const DESTINATIONS = ['Intake', 'RSVP', 'Gallery', 'Guestbook', 'Share', 'Settings'] as const;
// The compact rail band: 761 opens it and 1100 is the last width before the wide rails return.
const RAIL_WIDTHS = [761, 768, 780, 860, 1024, 1100];
// 1134 is the first width the old fixed tracks fit inside; everything under it pushed the page sideways.
const WIDE_WIDTHS = [1101, 1120, 1133, 1134, 1440];
// The stacked phone modes: one media column below 431, two from 431 up to the compact rail.
const ONE_COLUMN_WIDTHS = [320, 360, 390, 430];
const TWO_COLUMN_WIDTHS = [431, 470, 760];
// Manager destinations are controls, so their labels follow the binding 14–16px control-text band.
const MIN_LABEL_TEXT = 14;
const MIN_COUNT_TEXT = 12;
const MIN_CONTRAST = 4.5;
const TOUCH_MINIMUM = 44;
// Chromium can report adjacent CSS-pixel edges on different device-pixel boundaries by a fraction.
const GEOMETRY_TOLERANCE = 1;
const NOTE = {
  id: 'message-a',
  guestName: 'Rowan',
  body: 'To a lifetime of noticing the little things.',
  moderationStatus: 'pending' as const,
  createdAt: '2026-09-19T20:00:00Z',
};
// A count renders only when there is something to count, so both counted destinations carry one.
const mediaPages = { first: { media: makeMedia(2), nextCursor: null } };
const managerFixture = { mediaPages, messages: [NOTE], event: { storedMediaCount: 2 } };

// The Intake and Guestbook buttons carry a count, so their accessible name is not the destination alone.
function destination(page: Page, name: string) {
  return page.locator('.manager-nav nav button').filter({ hasText: name });
}

// Measured on the controls actually on screen, so a rule that never reaches them cannot pass this.
async function expectTouchTargets(page: Page, selector: string, label: string) {
  const controls = page.locator(selector);
  const rendered = await controls.count();
  expect(rendered, `${label} is on screen`).toBeGreaterThan(0);
  for (let index = 0; index < rendered; index += 1) {
    const size = await measureTarget(controls.nth(index));
    expect(size.width, `${label} ${index + 1} width`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    expect(size.height, `${label} ${index + 1} height`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
  }
}

// The two shared containment checks, run together because either alone has a blind spot: the document
// misses anything an `overflow: hidden` ancestor swallows, and the rect scan misses a widened shell.
// Scoped to the whole shell, so the nav and utility tracks are covered, not only the workspace.
async function expectContained(page: Page, width: number) {
  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth, `document at ${width}`).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  expect(await measureViewportEscapes(page.locator('.manager-shell--intake')), `shell escapes at ${width}`)
    .toEqual([]);
}

async function openManager(page: Page) {
  await stubManagerRoutes(page, managerFixture);
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
}

// The focused server's CSP blocks Vite's injected React Refresh preamble. These inert globals let
// browser traces mount the app without changing production CSP or exercising hot module replacement.
async function installInertReactRefresh(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      $RefreshReg$: () => undefined,
      $RefreshSig$: () => (type: unknown) => type,
    });
  });
}

test.beforeEach(async ({ page }) => {
  await installInertReactRefresh(page);
});

test('Manager upload cleanup retry at 320 stays contained and focuses its action', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    uploads: {
      contentFailure: 'network',
      cancelFailure: 'network',
    },
  });
  await page.goto(managerUrl);
  await page.getByRole('button', { name: 'Add photos' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add photos' });
  await dialog.locator('input[data-photo-source="library"]').setInputFiles({
    name: 'cleanup-retry.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('cleanup-retry'),
  });
  await dialog.getByRole('button', { name: 'Send 1 photo' }).click();
  await dialog.getByRole('button', { name: 'Cancel uploads' }).click();

  const retry = dialog.getByRole('button', { name: 'Retry cleanup' });
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(dialog).toContainText('1 temporary upload still needs cleanup.');
  const target = await measureTarget(retry);
  expect(target.width, 'Retry cleanup target width at 320').toBeGreaterThanOrEqual(TOUCH_MINIMUM);
  expect(target.height, 'Retry cleanup target height at 320').toBeGreaterThanOrEqual(TOUCH_MINIMUM);
  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth, 'Manager upload cleanup document at 320')
    .toBeLessThanOrEqual(documentSize.clientWidth + GEOMETRY_TOLERANCE);
  expect(await measureViewportEscapes(dialog), 'Manager upload cleanup dialog at 320').toEqual([]);
});

test('manager navigation keeps every destination labelled at the control-text floor', async ({ page }) => {
  await openManager(page);

  for (const width of [320, 390, ...RAIL_WIDTHS, 1101, 1440]) {
    await page.setViewportSize({ width, height: 900 });

    for (const name of DESTINATIONS) {
      const button = destination(page, name);
      const target = await measureTarget(button);
      expect(target.width, `${name} target width at ${width}`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
      expect(target.height, `${name} target height at ${width}`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);

      const label = button.locator('.manager-nav__label');
      await expect(label, `${name} label rendered at ${width}`).toBeVisible();
      const labelBox = await measureTarget(label);
      expect(labelBox.width, `${name} label width at ${width}`).toBeGreaterThan(0);
      expect(labelBox.height, `${name} label height at ${width}`).toBeGreaterThan(0);

      const fontSize = await label.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
      expect(fontSize, `${name} label text size at ${width}`).toBeGreaterThanOrEqual(MIN_LABEL_TEXT);
    }

    await expectContained(page, width);
  }
});

test('320 Manager navigation labels do not intersect', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: makeMedia(6), nextCursor: null } },
    messages: [NOTE],
    event: { storedMediaCount: 6 },
    exports: [],
  });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();

  const controls = page.locator('.manager-nav nav button');
  await expect(controls).toHaveCount(DESTINATIONS.length);
  const labels = await controls.locator('.manager-nav__label').all();
  const controlBoxes = [];
  expect(await controls.locator('.manager-nav__label').allTextContents(), 'Manager destination source order')
    .toEqual([...DESTINATIONS]);

  for (let first = 0; first < labels.length; first += 1) {
    for (let second = first + 1; second < labels.length; second += 1) {
      expect(
        await boxesIntersect(labels[first]!, labels[second]!),
        DESTINATIONS[first] + ' and ' + DESTINATIONS[second] + ' labels',
      ).toBe(false);
    }
  }

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index]!;
    const control = controls.nth(index);
    await expect(label, `${DESTINATIONS[index]} label is visible`).toBeVisible();
    const [controlBox, labelBox] = await Promise.all([control.boundingBox(), label.boundingBox()]);
    if (!controlBox || !labelBox) {
      throw new Error(`${DESTINATIONS[index]} requires rendered control and label bounds.`);
    }
    controlBoxes.push(controlBox);
    expect(controlBox.width, `${DESTINATIONS[index]} target width`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    expect(controlBox.height, `${DESTINATIONS[index]} target height`).toBeGreaterThanOrEqual(58);
    expect(labelBox.x, `${DESTINATIONS[index]} label starts inside its control`).toBeGreaterThanOrEqual(controlBox.x);
    expect(labelBox.x + labelBox.width, `${DESTINATIONS[index]} label ends inside its control`)
      .toBeLessThanOrEqual(controlBox.x + controlBox.width);
    expect(labelBox.y, `${DESTINATIONS[index]} label starts inside its control`).toBeGreaterThanOrEqual(controlBox.y);
    expect(labelBox.y + labelBox.height, `${DESTINATIONS[index]} label ends inside its control`)
      .toBeLessThanOrEqual(controlBox.y + controlBox.height);
    const fontSize = await label.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(fontSize, `${DESTINATIONS[index]} label text size`).toBeGreaterThanOrEqual(MIN_LABEL_TEXT);
  }

  const rowStarts = controlBoxes.reduce<number[]>((rows, box) => {
    if (!rows.some((rowStart) => Math.abs(rowStart - box.y) <= GEOMETRY_TOLERANCE)) rows.push(box.y);
    return rows;
  }, []);
  expect(rowStarts, 'Manager destinations render as exactly two rows').toHaveLength(2);
  for (let index = 0; index < controlBoxes.length; index += 1) {
    const expectedRow = index < 3 ? rowStarts[0]! : rowStarts[1]!;
    expect(
      Math.abs(controlBoxes[index]!.y - expectedRow),
      `${DESTINATIONS[index]} remains in its source-ordered row`,
    ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
  }
  expect(rowStarts[1]!, 'second Manager row follows the first')
    .toBeGreaterThanOrEqual(rowStarts[0]! + controlBoxes[0]!.height - GEOMETRY_TOLERANCE);

  const counts = controls.locator('.manager-nav__count');
  await expect(counts).toHaveCount(2);
  for (let index = 0; index < await counts.count(); index += 1) {
    const count = counts.nth(index);
    await expect(count, `Manager count ${index + 1} is visible`).toBeVisible();
    const control = count.locator('..');
    const [controlBox, countBox] = await Promise.all([control.boundingBox(), count.boundingBox()]);
    if (!controlBox || !countBox) {
      throw new Error(`Manager count ${index + 1} requires rendered control and count bounds.`);
    }
    const fontSize = await count.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(fontSize, `Manager count ${index + 1} text size`).toBeGreaterThanOrEqual(MIN_COUNT_TEXT);
    expect(countBox.x, `Manager count ${index + 1} starts inside its control`).toBeGreaterThanOrEqual(controlBox.x);
    expect(countBox.x + countBox.width, `Manager count ${index + 1} ends inside its control`)
      .toBeLessThanOrEqual(controlBox.x + controlBox.width);
    expect(countBox.y, `Manager count ${index + 1} starts inside its control`).toBeGreaterThanOrEqual(controlBox.y);
    expect(countBox.y + countBox.height, `Manager count ${index + 1} ends inside its control`)
      .toBeLessThanOrEqual(controlBox.y + controlBox.height);
  }
  await expectContained(page, 320);

  const managerHeadingMargin = await page.locator('#intake-title').evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).scrollMarginTop));

  await destination(page, 'Gallery').click();
  await expect(page.getByRole('heading', { name: 'Private Gallery' })).toBeVisible();
  const managerNav = page.locator('.manager-nav');
  const controlRow = page.locator('.gallery-control-row');
  const mosaicControl = page.locator('.gallery-mosaic__open').last();
  await mosaicControl.scrollIntoViewIfNeeded();
  const [managerNavBox, controlRowBox, mosaicControlBox, scrollY, stickyOffset, galleryHeadingMargin, mosaicMargin] =
    await Promise.all([
      managerNav.boundingBox(),
      controlRow.boundingBox(),
      mosaicControl.boundingBox(),
      page.evaluate(() => window.scrollY),
      page.locator('.manager-shell').evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--manager-sticky-offset'))),
      page.locator('#gallery-workspace-title').evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).scrollMarginTop)),
      mosaicControl.evaluate((element) => Number.parseFloat(getComputedStyle(element).scrollMarginTop)),
    ]);
  if (!managerNavBox || !controlRowBox || !mosaicControlBox) {
    throw new Error('Narrow Gallery requires rendered navigation, control-row, and mosaic-control bounds.');
  }
  expect(stickyOffset, 'narrow Manager sticky offset').toBe(169);
  expect(managerNavBox.height, 'two-row Manager navigation fits its declared offset').toBeLessThanOrEqual(stickyOffset);
  expect(managerNavBox.height, 'two-row Manager navigation consumes the declared offset').toBeGreaterThan(stickyOffset - 1);
  expect(await boxesIntersect(managerNav, controlRow), 'Manager navigation and Gallery control row').toBe(false);
  const managerToGalleryGap = controlRowBox.y - (managerNavBox.y + managerNavBox.height);
  expect(managerToGalleryGap, 'Gallery row does not overlap the Manager navigation')
    .toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE);
  expect(managerToGalleryGap, 'Gallery row begins at the Manager navigation bottom')
    .toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
  expect(Math.abs(controlRowBox.y - stickyOffset), 'sticky Gallery row uses the declared Manager offset')
    .toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
  const combinedStickyBottom = Math.max(
    managerNavBox.y + managerNavBox.height,
    controlRowBox.y + controlRowBox.height,
  );
  expect(scrollY, 'the 320 mosaic target is measured after scrolling').toBeGreaterThan(0);
  expect(mosaicControlBox.y, 'scrolled 320 mosaic target clears the measured sticky stack')
    .toBeGreaterThanOrEqual(combinedStickyBottom - GEOMETRY_TOLERANCE);
  const managerTracks = await measureGridTracks(page.locator('.manager-nav nav'));
  expect(managerTracks, 'Manager destination topology').toHaveLength(3);
  expect(managerHeadingMargin, 'narrow Manager heading scroll margin').toBe(stickyOffset + 12);
  expect(galleryHeadingMargin, 'narrow Gallery heading scroll margin').toBe(stickyOffset + 190 + 12);
  expect(mosaicMargin, 'narrow Gallery mosaic-control scroll margin').toBe(stickyOffset + 190 + 12);
  await expectContained(page, 320);
});

test('manager shell and media grid turn over exactly at their breakpoints', async ({ page }) => {
  await openManager(page);
  const shell = page.locator('.manager-shell--intake');
  const mediaGrid = page.locator('.moderation-grid');

  // Under 761 the manager is the stacked two-tier header, so the shell resolves no grid tracks at all.
  // The media grid turns over inside it at 431 regardless, which is the manager's fourth breakpoint.
  for (const width of ONE_COLUMN_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    expect(await measureGridTracks(shell), `shell tracks at ${width}`).toEqual([]);
    expect((await measureGridTracks(mediaGrid)).length, `media columns at ${width}`).toBe(1);
    await expectContained(page, width);
  }

  for (const width of TWO_COLUMN_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    expect(await measureGridTracks(shell), `shell tracks at ${width}`).toEqual([]);
    expect((await measureGridTracks(mediaGrid)).length, `media columns at ${width}`).toBe(2);
    await expectContained(page, width);
  }

  for (const width of RAIL_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const tracks = await measureGridTracks(shell);
    expect(tracks.length, `shell tracks at ${width}`).toBe(2);
    expect(tracks[0], `rail width at ${width}`).toBeCloseTo(104, 0);
    expect((await measureGridTracks(mediaGrid)).length, `media columns at ${width}`).toBe(2);
  }

  for (const width of WIDE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const tracks = await measureGridTracks(shell);
    expect(tracks.length, `shell tracks at ${width}`).toBe(3);
    expect(tracks[0], `rail width at ${width}`).toBeCloseTo(184, 0);
    expect(tracks[2], `utility rail width at ${width}`).toBeCloseTo(330, 0);
    expect((await measureGridTracks(mediaGrid)).length, `media columns at ${width}`).toBe(3);
  }
});

test('Intake photos use a compact mobile crop without shrinking card actions', async ({ page }) => {
  await openManager(page);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const photo = page.locator('.intake-grid .intake-photo > img').first();
    const bounds = await photo.boundingBox();
    if (!bounds) throw new Error(`The Intake photo requires rendered bounds at ${width}.`);
    expect(bounds.width / bounds.height, `Intake photo crop at ${width}`).toBeGreaterThanOrEqual(1.7);
    await expectTouchTargets(
      page,
      '.intake-grid article:first-of-type .intake-card-actions a, .intake-grid article:first-of-type .intake-card-actions button',
      `compact Intake card actions at ${width}`,
    );
    await expectContained(page, width);
  }
});

test('Library search integrates its submit icon on mobile and keeps its desktop label', async ({ page }) => {
  await openManager(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await destination(page, 'Gallery').click();
  await expect(page.getByRole('heading', { name: 'Private Gallery' })).toBeVisible();

  const searchForm = page.getByRole('search');
  const input = searchForm.getByRole('textbox', { name: 'Find photos' });
  const submit = searchForm.getByRole('button', { name: 'Search' });
  const label = submit.locator('.gallery-search__submit-label');
  const [mobileInput, mobileSubmit] = await Promise.all([input.boundingBox(), submit.boundingBox()]);
  if (!mobileInput || !mobileSubmit) throw new Error('Mobile search requires input and submit bounds.');
  expect(mobileSubmit.x, 'mobile Search begins inside the field').toBeGreaterThanOrEqual(mobileInput.x);
  expect(mobileSubmit.x + mobileSubmit.width, 'mobile Search ends inside the field')
    .toBeLessThanOrEqual(mobileInput.x + mobileInput.width + GEOMETRY_TOLERANCE);
  expect(mobileSubmit.y, 'mobile Search begins inside the field').toBeGreaterThanOrEqual(mobileInput.y);
  expect(mobileSubmit.y + mobileSubmit.height, 'mobile Search ends inside the field')
    .toBeLessThanOrEqual(mobileInput.y + mobileInput.height + GEOMETRY_TOLERANCE);
  expect(mobileSubmit.width, 'mobile Search touch width').toBeGreaterThanOrEqual(TOUCH_MINIMUM);
  expect(mobileSubmit.height, 'mobile Search touch height').toBeGreaterThanOrEqual(TOUCH_MINIMUM);
  await expect(label).toHaveCount(1);
  await expect(label).toBeHidden();

  await page.setViewportSize({ width: 761, height: 900 });
  const [desktopInput, desktopSubmit] = await Promise.all([input.boundingBox(), submit.boundingBox()]);
  if (!desktopInput || !desktopSubmit) throw new Error('Desktop search requires input and submit bounds.');
  expect(desktopSubmit.x, 'desktop Search follows the field')
    .toBeGreaterThanOrEqual(desktopInput.x + desktopInput.width);
  await expect(label).toBeVisible();
  await expectContained(page, 761);
});

test('a new Album section enters the mobile viewport without focus-induced scrolling', async ({ page }) => {
  const rows = makeMedia(10);
  await page.setViewportSize({ width: 390, height: 844 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    event: { storedMediaCount: rows.length },
    album: {
      saved: true,
      pickedMediaIds: rows.map(({ id }) => id),
    },
  });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await destination(page, 'Gallery').click();
  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Album \(10\)$/u }).click();

  const addSection = page.getByRole('button', { name: 'Add a section' });
  await addSection.scrollIntoViewIfNeeded();

  // Mobile Safari does not reliably scroll an off-screen field when focus happens
  // after the tap's user-activation turn. Model that contract directly: revealing
  // the new editor must not depend on the browser's focus-scroll side effect.
  await page.evaluate(() => {
    const nativeFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focusWithoutScroll(options?: FocusOptions) {
      nativeFocus.call(this, { ...options, preventScroll: true });
    };
  });

  await addSection.click();

  const sectionName = page.getByLabel('Section name');
  await expect(sectionName).toHaveValue('New section');
  await expect(sectionName).toBeFocused();
  const bounds = await sectionName.boundingBox();
  if (!bounds) throw new Error('The new mobile section editor requires rendered bounds.');
  expect(bounds.y, 'new section begins inside the mobile viewport').toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height, 'new section ends inside the mobile viewport')
    .toBeLessThanOrEqual(844);
});

// The rail is a grid item stretched to the full height of the shell. Without `align-content: start` its
// two rows stretch with it: the brand floats a third of the way down and the five destinations spread
// over roughly 600px. Every label stays visible, contained, above 44px and above the contrast floor
// while that happens, so only a packing measurement can see it.
test('manager rail keeps its brand and destinations packed at the top', async ({ page }) => {
  await openManager(page);

  for (const width of [...RAIL_WIDTHS, ...WIDE_WIDTHS]) {
    await page.setViewportSize({ width, height: 900 });

    const brand = await measureTarget(page.locator('.manager-nav .brand'));
    expect(brand.height, `brand height at ${width}`).toBeLessThanOrEqual(60);

    // Six buttons of at most 58px plus five 5px gaps is 373; a stretched rail measures over 600.
    const destinations = await measureTarget(page.locator('.manager-nav nav'));
    expect(destinations.height, `destination block height at ${width}`).toBeLessThanOrEqual(380);
  }
});

test('the manager Brand remains a 44 by 44 target when each navigation layout begins', async ({ page }) => {
  await openManager(page);

  for (const width of [320, 761, 1101]) {
    await page.setViewportSize({ width, height: 900 });
    const brand = await measureTarget(page.locator('.manager-nav .brand'));
    expect(brand.width, `Brand width at ${width}`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    expect(brand.height, `Brand height at ${width}`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    await expectContained(page, width);
  }
});

test('manager shell stays contained where the wide rails return', async ({ page }) => {
  await openManager(page);

  for (const width of WIDE_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // Rects survive clipping, so the shell cannot buy this assertion back with `overflow: hidden`.
    await expectContained(page, width);
  }
});

// The three lifecycle facts share a row while they fit. Without `flex-wrap: wrap` they never overflow —
// flex items shrink instead — they are silently squeezed until each fact breaks onto a second line, so
// containment cannot see this and only the fact's own line count can.
test('the lifecycle facts each stay on one line for an event at capacity', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages,
    messages: [NOTE],
    event: { storedMediaCount: MAX_EVENT_MEDIA, storedBytes: MAX_EVENT_BYTES },
  });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  const facts = page.locator('.lifecycle p');
  await expect(facts).toHaveCount(3);

  for (const width of [...RAIL_WIDTHS, ...WIDE_WIDTHS]) {
    await page.setViewportSize({ width, height: 900 });

    // Measured in each fact's own line height, because the rule sets none of its own.
    const lines = await facts.evaluateAll((elements) => elements.map((element) =>
      element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight)));
    for (const [index, count] of lines.entries()) {
      expect(count, `lifecycle fact ${index + 1} lines at ${width}`).toBeLessThan(1.5);
    }

    await expectContained(page, width);
  }
});

test('manager navigation keeps the unresolved Guestbook count visible on both sides of the rail', async ({ page }) => {
  await openManager(page);
  const guestbook = destination(page, 'Guestbook');
  const count = guestbook.locator('.manager-nav__count');

  for (const width of [320, 761, 1101]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(guestbook, `Guestbook is the inactive destination at ${width}`).toHaveAttribute('aria-pressed', 'false');
    await expect(count, `Guestbook count rendered at ${width}`).toBeVisible();
    await expect(count).toHaveText('1');

    const box = await measureTarget(count);
    expect(box.width, `Notes count width at ${width}`).toBeGreaterThan(0);
    expect(box.height, `Notes count height at ${width}`).toBeGreaterThan(0);

    const fontSize = await count.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(fontSize, `Notes count text size at ${width}`).toBeGreaterThanOrEqual(MIN_COUNT_TEXT);
  }
});

// The badge is a fixed-size box no containment assertion can reach: the digits that leave it are an
// anonymous box, not an element, so `measureViewportEscapes` and the document scan both see nothing.
// Only the badge's own scroll width reports it, and only the documented cap makes it happen.
test('the intake count badge holds the whole photo cap at every width', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages,
    messages: [NOTE],
    event: { storedMediaCount: MAX_EVENT_MEDIA, storedBytes: MAX_EVENT_BYTES },
  });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  const count = destination(page, 'Intake').locator('.manager-nav__count');
  await expect(count).toHaveText(String(MAX_EVENT_MEDIA));

  for (const width of [...ONE_COLUMN_WIDTHS, ...TWO_COLUMN_WIDTHS, ...RAIL_WIDTHS, ...WIDE_WIDTHS]) {
    await page.setViewportSize({ width, height: 900 });
    const badge = await measureOverflow(count);
    expect(badge.scrollWidth, `intake count contains ${MAX_EVENT_MEDIA} at ${width}`)
      .toBeLessThanOrEqual(badge.clientWidth + 1);
    // Still a badge rather than a bar: it grows with its digits and no further.
    const box = await measureTarget(count);
    expect(box.width, `intake count width at ${width}`).toBeLessThanOrEqual(48);
    await expectContained(page, width);
  }
});

// A 1280 px laptop at the 200% zoom WCAG expects leaves a 640 by 450 layout viewport. It lands in the
// two-column stacked band, where the shell has no rails and the whole manager is one column of content.
test('the manager holds every section in the 1280-at-200%-zoom layout', async ({ page }) => {
  await openManager(page);
  await page.setViewportSize({ width: 640, height: 450 });

  for (const name of DESTINATIONS) {
    await destination(page, name).click();
    await expect(destination(page, name), `${name} is the open destination`).toHaveAttribute('aria-pressed', 'true');
    const target = await measureTarget(destination(page, name));
    expect(target.width, `${name} target width at 640 by 450`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    expect(target.height, `${name} target height at 640 by 450`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    await expectContained(page, 640);
  }

  // The rails belong to 761 and above; at this size the manager is the stacked layout, not a squeezed
  // three-column one, and the two-column media grid is what the workspace carries.
  expect(await measureGridTracks(page.locator('.manager-shell--intake')), 'shell tracks at 640').toEqual([]);
  await destination(page, 'Intake').click();
  expect((await measureGridTracks(page.locator('.moderation-grid'))).length, 'media columns at 640').toBe(2);
});

test('changing manager section returns the host to the top of the new section', async ({ page }) => {
  const rows = makeMedia(120);
  await stubManagerRoutes(page, {
    mediaPages: {
      first: { media: rows.slice(0, MANAGER_MEDIA_PAGE_SIZE), nextCursor: 'page-two' },
      'page-two': { media: rows.slice(MANAGER_MEDIA_PAGE_SIZE), nextCursor: null },
    },
    messages: [NOTE],
    event: { storedMediaCount: rows.length },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();

  // A host who has scrolled a long way into the intake grid, exactly where the audit found the problem.
  await page.evaluate(() => window.scrollTo({ top: 4_000, behavior: 'instant' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1_000);

  await destination(page, 'Share').click();
  const heading = page.getByRole('heading', { name: 'Share your event' });
  await expect(heading).toBeVisible();
  await expect.poll(
    () => page.evaluate(() => window.scrollY),
    { message: 'the new section starts at its own top' },
  ).toBeLessThanOrEqual(1);

  // The header is sticky, so "at the top" has to mean below it rather than underneath it.
  expect(await measureSeparation(page.locator('.manager-nav'), heading), 'heading clears the sticky nav')
    .toBeGreaterThan(0);
});

test('a long unbroken guestbook note stays inside the manager at every width', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages,
    messages: [{ ...NOTE, body: UNBROKEN_NOTE }],
    event: { storedMediaCount: 2 },
  });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await destination(page, 'Guestbook').click();
  await expect(page.getByRole('heading', { name: 'Guestbook from the day' })).toBeVisible();
  const note = page.locator('.manager-guestbook__entry > p');
  await expect(note).toHaveText(UNBROKEN_NOTE);

  for (const width of [320, 900]) {
    await page.setViewportSize({ width, height: 844 });

    const noteSize = await measureOverflow(note);
    expect(noteSize.scrollWidth, `note wraps at ${width}`).toBeLessThanOrEqual(noteSize.clientWidth + 1);

    await expectContained(page, width);
  }
});

test('manager navigation labels clear the contrast floor at every width', async ({ page }) => {
  await openManager(page);

  for (const width of [320, 390, 761, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of DESTINATIONS) {
      const label = destination(page, name).locator('.manager-nav__label');
      const contrast = await measureContrast(label);
      expect(contrast, `${name} label contrast at ${width}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  }
});

test('manager cards keep the whole photo name reachable', async ({ page }) => {
  await openManager(page);
  const name = page.locator('.moderation-grid article').first().locator('strong');
  // The card shows what it can; the full name stays available rather than ending in an ellipsis.
  await expect(name).toHaveAttribute('title', LONG_FILENAME);
  await expect(name).toHaveText(LONG_FILENAME);

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // Height measured in its own text size, because the label sets no explicit line height.
    const lines = await name.evaluate((element) =>
      element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).fontSize));
    expect(lines, `card name lines at ${width}`).toBeGreaterThan(1.8);
    expect(lines, `card name stays compact at ${width}`).toBeLessThan(3.2);

    const nameSize = await measureOverflow(name);
    expect(nameSize.scrollWidth, `card name wraps at ${width}`).toBeLessThanOrEqual(nameSize.clientWidth + 1);
  }
});

test('every manager control the host can touch measures at least 44 by 44', async ({ page }) => {
  const job: ExportView = {
    id: 'export-a', kind: 'complete', state: 'ready', snapshotAt: '2026-09-20T09:00:00Z',
    createdAt: '2026-09-20T09:00:00Z', startedAt: '2026-09-20T09:00:01Z',
    completedAt: '2026-09-20T09:00:03Z', processedMediaCount: 2, processedBytes: 256,
    progressUpdatedAt: '2026-09-20T09:00:03Z', errorCode: null,
    mediaCount: 2, totalBytes: 256, attempt: 1, partCount: 1, expiresAt: '2026-09-27T09:00:00Z',
    guestbookEntryCount: 1, guestbookSharedCount: 1, guestbookEventName: 'Maya & Theo',
    guestbookEventDate: '2026-09-19', guestbookEventTimezone: 'America/Chicago',
    guestbookPrompt: 'Share a memory.', guestbookGalleryVisible: true,
  };
  // Unpublished is the Gallery's own default filter and the only state that renders all four card
  // controls at once, so it is the state the 44px minimums actually have to fit.
  await stubManagerRoutes(page, {
    ...managerFixture,
    mediaPages: { first: { media: makeMedia(2, 'unpublished'), nextCursor: null } },
    exports: [job],
  });
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/exports/${job.id}/download`, (route) => route.fulfill({
    json: { data: {
      manifest: { url: 'https://candidary.test/export/manifest.csv', expiresAt: job.expiresAt, filename: 'candidary-export-manifest.csv' },
      parts: [{ partNumber: 1, mediaCount: 2, sourceBytes: 256, url: 'https://candidary.test/export/part-1.zip', expiresAt: job.expiresAt, filename: 'candidary-export-part-1.zip' }],
    }, requestId: 'request-a' },
  }));
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await page.getByLabel('Filter by guest name').fill('Rowan');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeVisible();

  // Every media-grid mode: one phone column, the 431 two-column band, and the three-column rail layout.
  for (const width of [390, 431, 470, 1200]) {
    await page.setViewportSize({ width, height: 900 });

    await destination(page, 'Intake').click();
    await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
    await expectTouchTargets(page, '.intake-search .button', `intake filter at ${width}`);
    await expectTouchTargets(page, '.intake-search .text-button', `intake clear at ${width}`);
    await expectTouchTargets(page, '.moderation-grid article:first-of-type .intake-card-actions a', `intake download at ${width}`);
    await expectTouchTargets(page, '.moderation-grid article:first-of-type .intake-card-actions button', `intake card control at ${width}`);

    await destination(page, 'Gallery').click();
    await page.getByRole('button', { name: 'Guest gallery' }).click();
    await expectTouchTargets(page, '.filter-tabs button', `publication filter at ${width}`);
    await expectTouchTargets(page, '.bulk-bar .button', `bulk control at ${width}`);
    await expectTouchTargets(page, '.moderation-grid article:first-of-type button', `gallery card control at ${width}`);

    // Gallery's copy of the bulk bar is scoped a class deeper than the shared rule, so it outranks
    // the 761 layout unless it opts back in by name. Touch targets and containment both survive a
    // full-bleed stack, so only the row itself reports that the wide layout was lost.
    const bulkTops = await page.locator('.gallery-shared .bulk-bar .button').evaluateAll(
      (nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
    );
    expect(bulkTops.length, `two bulk controls at ${width}`).toBe(2);
    expect(new Set(bulkTops).size, `bulk controls share one row from 761 and stack below it at ${width}`)
      .toBe(width >= 761 ? 1 : 2);

    // The card clips its own corners, so a control pushed past its edge still measures 44x44 and still
    // stays inside the viewport. Only the row that holds them reports that it ran out of width.
    const actions = page.locator('.moderation-grid article:first-of-type .intake-card-actions');
    const actionRow = await measureOverflow(actions);
    expect(actionRow.scrollWidth, `card controls fit their row at ${width}`)
      .toBeLessThanOrEqual(actionRow.clientWidth + 1);

    await destination(page, 'Guestbook').click();
    await expect(page.locator('.manager-guestbook__entry .button').first()).toBeVisible();
    await expectTouchTargets(page, '.manager-guestbook__entry .button', `Guestbook control at ${width}`);

    await destination(page, 'Gallery').click();
    await page.getByRole('button', { name: 'Library' }).click();
    const panel = page.locator('.gallery-export');
    const links = panel.locator('.export-links a');
    if (await links.count() === 0) await panel.getByRole('button', { name: 'Get download links' }).click();
    await expect(links.first()).toBeVisible();
    await expectTouchTargets(page, '.gallery-export .export-links a', `export link at ${width}`);

    await expectContained(page, width);
  }
});

test('active export progress stays reachable and contained outside Gallery on narrow screens', async ({ page }) => {
  const job: ExportView = {
    id: 'running-complete-export',
    kind: 'complete',
    state: 'running',
    snapshotAt: '2026-09-20T09:00:00Z',
    createdAt: '2026-09-20T09:00:00Z',
    startedAt: '2026-09-20T09:00:01Z',
    completedAt: null,
    mediaCount: 2,
    totalBytes: 256,
    processedMediaCount: 1,
    processedBytes: 128,
    progressUpdatedAt: '2026-09-20T09:00:02Z',
    attempt: 1,
    partCount: 0,
    expiresAt: null,
    guestbookEntryCount: 1,
    guestbookSharedCount: 1,
    guestbookEventName: EVENT_FIXTURE.name,
    guestbookEventDate: EVENT_FIXTURE.eventDate,
    guestbookEventTimezone: EVENT_FIXTURE.eventTimezone,
    guestbookPrompt: EVENT_FIXTURE.guestbookPrompt,
    guestbookGalleryVisible: EVENT_FIXTURE.galleryVisible,
    errorCode: null,
  };
  await stubManagerRoutes(page, { ...managerFixture, exports: [job] });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();

  const compact = page.getByRole('region', { name: 'Export progress' });
  await expect(compact).toContainText('Complete export · Running');
  await expect(compact).toContainText('1 of 2 photos processed');
  await expect(page.locator('[data-gallery-live-host="true"]')).toHaveCount(1);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expectTouchTargets(page, '.manager-export-compact .button', `compact export action at ${width}`);
    const compactSize = await measureOverflow(compact);
    expect(compactSize.scrollWidth, `compact export status at ${width}`)
      .toBeLessThanOrEqual(compactSize.clientWidth + 1);
    await expectContained(page, width);
  }

  await compact.getByRole('button', { name: 'Open Gallery' }).click();
  await expect(compact).toHaveCount(0);
  await expect(page.locator('.gallery-export .export-state').getByText('Running', { exact: true }))
    .toBeVisible();
});

test('Library first photo intersects the initial 390 by 844 viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: makeMedia(6), nextCursor: null } },
    event: { storedMediaCount: 6 },
    exports: [],
    galleryAudienceSummary: {
      albumPhotoCount: 0,
      albumEntryCount: 0,
      albumLink: { active: true, sharedAt: '2026-09-19T20:00:00Z' },
      guestGalleryVisible: false,
      guestGalleryPublishedCount: 0,
    },
  });
  await page.goto(managerUrl);
  await destination(page, 'Gallery').click();
  await expect(page.getByRole('heading', { name: 'Private Gallery' })).toBeVisible();

  const firstPhoto = page.locator('.gallery-mosaic__item').first();
  await expect(firstPhoto).toBeVisible();
  // Keep the fold assertion ahead of the new obstruction selector so RED records the incumbent
  // layout defect even before the control-row structure exists.
  const initialBounds = await firstPhoto.boundingBox();
  if (!initialBounds) throw new Error('The first Library photo must have rendered bounds.');
  expect(initialBounds.y, 'first Library photo starts inside the initial viewport')
    .toBeLessThan(844);

  const obstructions = [page.locator('.manager-nav'), page.locator('.gallery-control-row')] as const;
  const fold = await measureFoldBelowObstructions(firstPhoto, obstructions, 844);
  expect(fold.top).toBeLessThan(844);
  expect(fold.top).toBeGreaterThanOrEqual(fold.effectiveVisibleTop);
  expect(fold.visibleHeight).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
  const obstructionBoxes = await Promise.all(obstructions.map((obstruction) => obstruction.boundingBox()));
  for (const box of obstructionBoxes) {
    if (!box) throw new Error('Every sticky obstruction must have rendered bounds.');
    expect(fold.top, 'first Library photo clears each sticky obstruction')
      .toBeGreaterThanOrEqual(box.y + box.height);
  }

  await expectTouchTargets(page, '.gallery-mode-switch--three button', 'Gallery mode control at 390');
  await expectContained(page, 390);

  const controlRow = page.locator('.gallery-control-row');
  const collapsedControlRow = await controlRow.boundingBox();
  if (!collapsedControlRow) throw new Error('Collapsed Gallery controls require rendered bounds.');
  await expect(page.getByText('About this Gallery view', { exact: true })).toHaveCount(0);
  await expect(page.getByText('What the complete download includes', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download all' })).toBeVisible();

  const stickyTarget = page.locator('.gallery-mosaic__open').first();
  await stickyTarget.evaluate((element) => {
    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY);
    document.documentElement.style.scrollBehavior = previousScrollBehavior;
  });
  const [obstructingManagerNav, obstructingControlRow, obstructedTarget, scrollBeforeNative] = await Promise.all([
    page.locator('.manager-nav').boundingBox(),
    controlRow.boundingBox(),
    stickyTarget.boundingBox(),
    page.evaluate(() => window.scrollY),
  ]);
  if (!obstructingManagerNav || !obstructingControlRow || !obstructedTarget) {
    throw new Error('The native Library focus path requires an initially obstructed target and sticky bounds.');
  }
  expect(obstructedTarget.y, 'Library target starts underneath the sticky Gallery row')
    .toBeLessThan(obstructingControlRow.y + obstructingControlRow.height - GEOMETRY_TOLERANCE);
  expect(obstructedTarget.y + obstructedTarget.height, 'obstructed Library target intersects the sticky stack')
    .toBeGreaterThan(obstructingManagerNav.y + obstructingManagerNav.height);

  await stickyTarget.evaluate((element) => {
    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    element.scrollIntoView({ block: 'start', inline: 'nearest' });
    element.focus({ preventScroll: true });
    document.documentElement.style.scrollBehavior = previousScrollBehavior;
  });
  await expect(stickyTarget).toBeFocused();
  const [managerNavBox, stickyControlRow, stickyTargetBox, scrollAfterNative] = await Promise.all([
    page.locator('.manager-nav').boundingBox(),
    controlRow.boundingBox(),
    stickyTarget.boundingBox(),
    page.evaluate(() => window.scrollY),
  ]);
  if (!managerNavBox || !stickyControlRow || !stickyTargetBox) {
    throw new Error('Sticky Gallery focus requires every obstruction and target bound.');
  }
  expect(scrollBeforeNative - scrollAfterNative, 'native Library focus makes a real scroll transition')
    .toBeGreaterThan(GEOMETRY_TOLERANCE);
  expect(stickyControlRow.y, 'Gallery control row sticks below the Manager navigation')
    .toBeGreaterThanOrEqual(managerNavBox.y + managerNavBox.height - GEOMETRY_TOLERANCE);
  expect(stickyTargetBox.y, 'focused mosaic control clears the actual Manager navigation')
    .toBeGreaterThanOrEqual(managerNavBox.y + managerNavBox.height - GEOMETRY_TOLERANCE);
  expect(stickyTargetBox.y, 'focused mosaic control clears the actual sticky Gallery row')
    .toBeGreaterThanOrEqual(stickyControlRow.y + stickyControlRow.height - GEOMETRY_TOLERANCE);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expectContained(page, 390);
});

test('audience failure stays below the mobile Gallery sticky row', async ({ page }) => {
  let audienceReadShouldFail = true;
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: makeMedia(6), nextCursor: null } },
    event: { storedMediaCount: 6 },
    exports: [],
  });
  const audienceRoute = `**/api/manage/events/${EVENT_FIXTURE.id}/gallery/summary`;
  await page.unroute(audienceRoute);
  await page.route(audienceRoute, async (route) => {
    if (!audienceReadShouldFail) {
      await route.fulfill({
        json: {
          data: {
            summary: {
              albumPhotoCount: 0,
              albumEntryCount: 0,
              albumLink: { active: false, sharedAt: null },
              guestGalleryVisible: true,
              guestGalleryPublishedCount: 6,
            },
          },
          requestId: 'audience-responsive-success',
        },
      });
      return;
    }
    await route.fulfill({
      status: 503,
      json: {
        code: 'INTERNAL_ERROR',
        message: 'The Gallery audience status is temporarily unavailable while the event audience is being refreshed.',
        requestId: 'audience-responsive-failure',
      },
    });
  });

  for (const width of [390, 320]) {
    audienceReadShouldFail = true;
    await page.setViewportSize({ width, height: 844 });
    await page.goto(managerUrl);
    await destination(page, 'Gallery').click();
    await expect(page.getByRole('heading', { name: 'Private Gallery' })).toBeVisible();

    const controlRow = page.locator('.gallery-control-row');
    const managerGallery = page.locator('.manager-gallery');
    const audienceFailure = page.locator('.state-card--error').filter({
      hasText: 'The Gallery audience status is temporarily unavailable',
    });
    const retry = audienceFailure.getByRole('button', { name: 'Try again' });
    await expect(audienceFailure, `audience failure at ${width}`).toBeVisible();
    expect(await audienceFailure.evaluate((failure) => ({
      parentClass: failure.parentElement?.className ?? null,
      previousSiblingClass: failure.previousElementSibling?.className ?? null,
    })), `audience failure is a direct normal-flow sibling at ${width}`).toEqual({
      parentClass: 'manager-gallery',
      previousSiblingClass: 'gallery-control-row',
    });

    const [failureRowBox, failureBox, managerGalleryBox, failureBudget, failurePosition] = await Promise.all([
      controlRow.boundingBox(),
      audienceFailure.boundingBox(),
      managerGallery.boundingBox(),
      page.locator('.manager-shell').evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--gallery-control-obstruction'))),
      audienceFailure.evaluate((failure) => getComputedStyle(failure).position),
    ]);
    if (!failureRowBox || !failureBox || !managerGalleryBox) {
      throw new Error(`Audience failure requires state, parent, and Gallery control bounds at ${width}.`);
    }
    expect(failurePosition, `audience failure stays in normal flow at ${width}`).toBe('static');
    expect(Math.abs(failureBox.x - managerGalleryBox.x), `audience failure shares its parent left edge at ${width}`)
      .toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
    expect(
      Math.abs(
        failureBox.x + failureBox.width - (managerGalleryBox.x + managerGalleryBox.width),
      ),
      `audience failure shares its parent right edge at ${width}`,
    ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
    expect(failureBox.y, `audience failure starts after the Gallery control row at ${width}`)
      .toBeGreaterThanOrEqual(failureRowBox.y + failureRowBox.height - GEOMETRY_TOLERANCE);
    expect(failureRowBox.height, `failed audience read stays inside the successful-row obstruction budget at ${width}`)
      .toBeLessThanOrEqual(failureBudget);
    const failureOverflow = await measureOverflow(audienceFailure);
    expect(failureOverflow.scrollWidth, `audience failure content stays contained at ${width}`)
      .toBeLessThanOrEqual(failureOverflow.clientWidth + 1);
    await expectContained(page, width);
    const retrySize = await measureTarget(retry);
    expect(retrySize.width, `audience Retry width at ${width}`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    expect(retrySize.height, `audience Retry height at ${width}`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);

    const downstreamControl = page.locator('.gallery-mosaic__open').first();
    await downstreamControl.evaluate((element) => {
      const previousScrollBehavior = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY);
      document.documentElement.style.scrollBehavior = previousScrollBehavior;
    });
    const [obstructingManagerNav, obstructingStickyRow, obstructedDownstream, scrollBeforeNative] = await Promise.all([
      page.locator('.manager-nav').boundingBox(),
      controlRow.boundingBox(),
      downstreamControl.boundingBox(),
      page.evaluate(() => window.scrollY),
    ]);
    if (!obstructingManagerNav || !obstructingStickyRow || !obstructedDownstream) {
      throw new Error(`Audience failure requires an initially obstructed downstream target at ${width}.`);
    }
    expect(obstructedDownstream.y, `downstream target starts underneath the sticky Gallery row at ${width}`)
      .toBeLessThan(obstructingStickyRow.y + obstructingStickyRow.height - GEOMETRY_TOLERANCE);
    expect(
      obstructedDownstream.y + obstructedDownstream.height,
      `obstructed downstream target intersects the sticky stack at ${width}`,
    ).toBeGreaterThan(obstructingManagerNav.y + obstructingManagerNav.height);

    await downstreamControl.evaluate((element) => {
      const previousScrollBehavior = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      element.scrollIntoView({ block: 'start', inline: 'nearest' });
      element.focus({ preventScroll: true });
      document.documentElement.style.scrollBehavior = previousScrollBehavior;
    });
    await expect(downstreamControl, `downstream Library control is focused at ${width}`).toBeFocused();
    const [managerNavBox, stickyRowBox, downstreamBox, scrollAfterNative] = await Promise.all([
      page.locator('.manager-nav').boundingBox(),
      controlRow.boundingBox(),
      downstreamControl.boundingBox(),
      page.evaluate(() => window.scrollY),
    ]);
    if (!managerNavBox || !stickyRowBox || !downstreamBox) {
      throw new Error(`Audience failure focus clearance requires rendered bounds at ${width}.`);
    }
    expect(
      scrollBeforeNative - scrollAfterNative,
      `native downstream focus makes a real scroll transition at ${width}`,
    ).toBeGreaterThan(GEOMETRY_TOLERANCE);
    expect(stickyRowBox.y, `Gallery row sticks below Manager navigation at ${width}`)
      .toBeGreaterThanOrEqual(managerNavBox.y + managerNavBox.height - GEOMETRY_TOLERANCE);
    expect(downstreamBox.y, `focused downstream content clears Manager navigation at ${width}`)
      .toBeGreaterThanOrEqual(managerNavBox.y + managerNavBox.height - GEOMETRY_TOLERANCE);
    expect(downstreamBox.y, `focused downstream content clears the actual Gallery sticky row at ${width}`)
      .toBeGreaterThanOrEqual(stickyRowBox.y + stickyRowBox.height - GEOMETRY_TOLERANCE);

    audienceReadShouldFail = false;
    await retry.click();
    await expect(audienceFailure, `audience failure clears after Retry at ${width}`).toHaveCount(0);
    await expect(page.locator('.gallery-audience-summary')).toContainText('Album: 0 photos');
    const [successfulRowBox, successfulBudget] = await Promise.all([
      controlRow.boundingBox(),
      page.locator('.manager-shell').evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--gallery-control-obstruction'))),
    ]);
    if (!successfulRowBox) throw new Error(`Successful audience read requires Gallery control bounds at ${width}.`);
    expect(successfulBudget, `audience state does not change the obstruction budget at ${width}`)
      .toBe(failureBudget);
    expect(successfulRowBox.height, `successful audience row fits its obstruction budget at ${width}`)
      .toBeLessThanOrEqual(successfulBudget);
    expect(failureRowBox.height, `failed audience state does not enlarge the successful Gallery row at ${width}`)
      .toBeLessThanOrEqual(successfulRowBox.height + GEOMETRY_TOLERANCE);
  }
});

test('the mobile Library tray, reopened Undo, Album, and Guest gallery stay reachable and contained', async ({ page }) => {
  const rows = makeMedia(4, 'unpublished');
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    event: { storedMediaCount: rows.length, storedBytes: 512 },
  });
  await page.goto(managerUrl);
  await destination(page, 'Gallery').click();
  await expect(page.getByRole('heading', { name: 'Private Gallery' })).toBeVisible();

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const modeSwitch = page.getByRole('group', { name: 'Gallery mode' });
    const libraryMode = modeSwitch.getByRole('button', { name: 'Library' });
    if (width === 320) {
      const modeTracks = await measureGridTracks(page.locator('.gallery-mode-switch--three'));
      expect(modeTracks, 'Gallery modes stack at 320').toHaveLength(1);
      await expectTouchTargets(page, '.gallery-mode-switch--three button', 'Gallery mode control at 320');
      for (const name of ['Library', 'Album', 'Guest gallery'] as const) {
        const modeControl = modeSwitch.getByRole('button', { name });
        await expect(modeControl, `${name} remains reachable at 320`).toBeVisible();
        await modeControl.click();
        await expect(modeControl, `${name} can be selected at 320`).toHaveAttribute('aria-pressed', 'true');
      }
    }
    await libraryMode.click();
    const selecting = page.getByRole('button', { name: /^(Select photos|Done selecting)$/u });
    if (await selecting.getAttribute('aria-pressed') === 'true') await selecting.click();
    await page.getByRole('button', { name: 'Select photos' }).click();
    const firstRow = rows[0]!;
    const first = page.getByRole('button', {
      name: `Select ${firstRow.caption}, from ${firstRow.guestName}`,
      exact: true,
    });
    await first.click();
    const tray = page.getByRole('region', { name: 'Album' });
    await expect(tray).toBeVisible();
    await expectTouchTargets(page, '.selection-tray button', `selection tray at ${width}`);
    if (width === 320) {
      const trayCopy = tray.locator('.selection-tray__count span');
      const [trayBounds, trayCopyBounds, textFragments] = await Promise.all([
        tray.boundingBox(),
        trayCopy.boundingBox(),
        trayCopy.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return Array.from(range.getClientRects()).map((rect) => ({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          })).filter((rect) => rect.width > 0 && rect.height > 0);
        }),
      ]);
      if (!trayBounds || !trayCopyBounds) throw new Error('Initial 320 tray copy requires rendered bounds.');
      expect.soft(trayCopyBounds.x, 'initial 320 tray explanation starts inside the tray')
        .toBeGreaterThanOrEqual(trayBounds.x - GEOMETRY_TOLERANCE);
      expect.soft(trayCopyBounds.x + trayCopyBounds.width, 'initial 320 tray explanation ends inside the tray')
        .toBeLessThanOrEqual(trayBounds.x + trayBounds.width + GEOMETRY_TOLERANCE);
      for (const [index, fragment] of textFragments.entries()) {
        expect.soft(fragment.x, `initial 320 tray fragment ${index + 1} starts inside the tray`)
          .toBeGreaterThanOrEqual(trayBounds.x - GEOMETRY_TOLERANCE);
        expect.soft(fragment.x + fragment.width, `initial 320 tray fragment ${index + 1} ends inside the tray`)
          .toBeLessThanOrEqual(trayBounds.x + trayBounds.width + GEOMETRY_TOLERANCE);
        expect.soft(fragment.x + fragment.width, `initial 320 tray fragment ${index + 1} ends inside the viewport`)
          .toBeLessThanOrEqual(width + GEOMETRY_TOLERANCE);
      }
      expect.soft(await measureViewportEscapes(tray), 'initial 320 tray descendants stay contained').toEqual([]);
    }

    const lastTile = page.locator('.gallery-mosaic__item').last();
    // The tray is fixed, so browser visibility alone cannot tell that it occludes a
    // tile. Scroll to the real document end and prove the reserved content space can
    // lift the final mosaic row fully above it.
    await page.evaluate(() => {
      const previousScrollBehavior = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, document.documentElement.scrollHeight);
      document.documentElement.style.scrollBehavior = previousScrollBehavior;
    });
    const lastBounds = await lastTile.boundingBox();
    const trayBounds = await tray.boundingBox();
    if (!lastBounds || !trayBounds) throw new Error(`Library geometry missing at ${width}`);
    expect(lastBounds.y + lastBounds.height, `last tile clears tray at ${width}`)
      .toBeLessThanOrEqual(trayBounds.y + 1);
    await page.getByRole('button', { name: 'Clear selection' }).click();
    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth, `Gallery document at ${width}`)
      .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }

  const selectionToggle = page.getByRole('button', { name: /^(Select photos|Done selecting)$/u });
  if (await selectionToggle.getAttribute('aria-pressed') === 'true') await selectionToggle.click();
  await page.getByRole('button', { name: 'Select photos' }).click();
  const firstRow = rows[0]!;
  await page.getByRole('button', {
    name: `Select ${firstRow.caption}, from ${firstRow.guestName}`,
    exact: true,
  }).click();
  const tray = page.getByRole('region', { name: 'Album' });
  await tray.getByRole('button', { name: 'Pick for Album (1)' }).click();
  const undo = page.locator('.album-undo__bar');
  await expect(undo).toBeVisible();
  await page.getByRole('button', { name: 'Select photos' }).click();
  const secondRow = rows[1]!;
  await page.getByRole('button', {
    name: `Select ${secondRow.caption}, from ${secondRow.guestName}`,
    exact: true,
  }).click();
  await expect(tray).toBeVisible();
  // The persistent Manager-owned Undo is a sibling of the Gallery workspace.
  // Prove its shared-shell collision rule at both sides of the layout breakpoint.
  for (const width of [761, 768, 840, 899, 900, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    if (width === 390 || width === 320) {
      await page.locator('.gallery-mosaic__open').last().scrollIntoViewIfNeeded();
    }
    const managerNav = page.locator('.manager-nav');
    const galleryControlRow = page.locator('.gallery-control-row');
    const trayCopy = tray.locator('.selection-tray__count span');
    const [managerNavBounds, galleryControlRowBounds, reopenedTray, undoBounds, trayCopyBounds] = await Promise.all([
      managerNav.boundingBox(),
      galleryControlRow.boundingBox(),
      tray.boundingBox(),
      undo.boundingBox(),
      trayCopy.boundingBox(),
    ]);
    if (!managerNavBounds || !galleryControlRowBounds || !reopenedTray || !undoBounds || !trayCopyBounds) {
      throw new Error(`Manager navigation, Gallery controls, Undo, tray, and copy geometry is required at ${width}`);
    }
    const separated = reopenedTray.y + reopenedTray.height <= undoBounds.y + 1
      || undoBounds.y + undoBounds.height <= reopenedTray.y + 1
      || reopenedTray.x + reopenedTray.width <= undoBounds.x + 1
      || undoBounds.x + undoBounds.width <= reopenedTray.x + 1;
    expect(separated, `Undo does not cover the reopened tray at ${width}`).toBe(true);
    await expectTouchTargets(page, '.album-undo__bar button', `Undo controls at ${width}`);
    await expectTouchTargets(page, '.selection-tray button', `reopened selection tray at ${width}`);
    if (width === 761 || width === 899) {
      const [managerOffset, galleryObstruction] = await page.locator('.manager-shell').evaluate((element) => {
        const style = getComputedStyle(element);
        return [
          Number.parseFloat(style.getPropertyValue('--manager-sticky-offset')),
          Number.parseFloat(style.getPropertyValue('--gallery-control-obstruction')),
        ];
      });
      expect.soft(Math.abs(undoBounds.y - managerOffset!), `Undo uses only the Manager offset at ${width}`)
        .toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
      expect.soft(undoBounds.y, `Undo is not displaced by the non-sticky Gallery obstruction at ${width}`)
        .toBeLessThan(managerOffset! + galleryObstruction! - GEOMETRY_TOLERANCE);
    }
    if (width === 390 || width === 320) {
      expect(await boxesIntersect(managerNav, galleryControlRow), `Manager navigation and Gallery controls at ${width}`)
        .toBe(false);
      expect(await boxesIntersect(managerNav, undo), `Manager navigation and reopened Undo at ${width}`).toBe(false);
      expect(await boxesIntersect(managerNav, tray), `Manager navigation and reopened tray at ${width}`).toBe(false);
      expect.soft(await boxesIntersect(galleryControlRow, undo), `Gallery controls and reopened Undo at ${width}`)
        .toBe(false);
      expect(await boxesIntersect(galleryControlRow, tray), `Gallery controls and reopened tray at ${width}`).toBe(false);
      expect(await boxesIntersect(undo, tray), `reopened Undo and tray at ${width}`).toBe(false);
      expect(galleryControlRowBounds.y, `Gallery controls start below Manager navigation at ${width}`)
        .toBeGreaterThanOrEqual(managerNavBounds.y + managerNavBounds.height - GEOMETRY_TOLERANCE);
      expect.soft(undoBounds.y, `reopened Undo starts below the full sticky stack at ${width}`)
        .toBeGreaterThanOrEqual(
          galleryControlRowBounds.y + galleryControlRowBounds.height - GEOMETRY_TOLERANCE,
        );
      expect(reopenedTray.y, `reopened tray starts below Undo at ${width}`)
        .toBeGreaterThanOrEqual(undoBounds.y + undoBounds.height - GEOMETRY_TOLERANCE);
      const documentSize = await measureDocument(page);
      expect(documentSize.scrollWidth, `simultaneous-state document at ${width}`)
        .toBeLessThanOrEqual(documentSize.clientWidth + GEOMETRY_TOLERANCE);
      for (const [name, box] of [
        ['Manager navigation', managerNavBounds],
        ['Gallery controls', galleryControlRowBounds],
        ['reopened Undo', undoBounds],
        ['reopened selection tray', reopenedTray],
      ] as const) {
        expect(box.x, `${name} starts inside the ${width} viewport`).toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE);
        expect(box.x + box.width, `${name} ends inside the ${width} viewport`)
          .toBeLessThanOrEqual(width + GEOMETRY_TOLERANCE);
        expect(box.y, `${name} starts inside the 844 viewport`).toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE);
        expect(box.y + box.height, `${name} ends inside the 844 viewport`)
          .toBeLessThanOrEqual(844 + GEOMETRY_TOLERANCE);
      }
      for (const [name, locator, containerBox] of [
        ['Undo', undo.locator('button'), undoBounds],
        ['selection tray', tray.locator('button'), reopenedTray],
      ] as const) {
        for (let index = 0; index < await locator.count(); index += 1) {
          const controlBox = await locator.nth(index).boundingBox();
          if (!controlBox) throw new Error(`${name} control ${index + 1} requires rendered bounds at ${width}`);
          expect(controlBox.x, `${name} control ${index + 1} starts inside its surface`)
            .toBeGreaterThanOrEqual(containerBox.x - GEOMETRY_TOLERANCE);
          expect(controlBox.x + controlBox.width, `${name} control ${index + 1} ends inside its surface`)
            .toBeLessThanOrEqual(containerBox.x + containerBox.width + GEOMETRY_TOLERANCE);
          expect(controlBox.y, `${name} control ${index + 1} starts inside its surface`)
            .toBeGreaterThanOrEqual(containerBox.y - GEOMETRY_TOLERANCE);
          expect(controlBox.y + controlBox.height, `${name} control ${index + 1} ends inside its surface`)
            .toBeLessThanOrEqual(containerBox.y + containerBox.height + GEOMETRY_TOLERANCE);
        }
      }
      const textFragments = await trayCopy.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return Array.from(range.getClientRects()).map((rect) => ({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })).filter((rect) => rect.width > 0 && rect.height > 0);
      });
      expect(textFragments, `tray explanation has rendered text fragments at ${width}`).not.toEqual([]);
      expect.soft(trayCopyBounds.x, `tray explanation starts inside the tray at ${width}`)
        .toBeGreaterThanOrEqual(reopenedTray.x - GEOMETRY_TOLERANCE);
      expect.soft(trayCopyBounds.x + trayCopyBounds.width, `tray explanation ends inside the tray at ${width}`)
        .toBeLessThanOrEqual(reopenedTray.x + reopenedTray.width + GEOMETRY_TOLERANCE);
      for (const [index, fragment] of textFragments.entries()) {
        expect.soft(fragment.x, `tray text fragment ${index + 1} starts inside the tray at ${width}`)
          .toBeGreaterThanOrEqual(reopenedTray.x - GEOMETRY_TOLERANCE);
        expect.soft(fragment.x + fragment.width, `tray text fragment ${index + 1} ends inside the tray at ${width}`)
          .toBeLessThanOrEqual(reopenedTray.x + reopenedTray.width + GEOMETRY_TOLERANCE);
        expect.soft(fragment.x, `tray text fragment ${index + 1} starts inside the viewport at ${width}`)
          .toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE);
        expect.soft(fragment.x + fragment.width, `tray text fragment ${index + 1} ends inside the viewport at ${width}`)
          .toBeLessThanOrEqual(width + GEOMETRY_TOLERANCE);
      }
      expect.soft(await measureViewportEscapes(tray), `reopened tray descendants stay contained at ${width}`)
        .toEqual([]);
    }
  }

  await page.setViewportSize({ width: 320, height: 568 });
  const shortManagerNav = page.locator('.manager-nav');
  const shortGalleryRow = page.locator('.gallery-control-row');
  const shortUndo = page.locator('.album-undo__bar');
  const shortTray = page.locator('.selection-tray');
  const shortTrayCopy = shortTray.locator('.selection-tray__count span');
  await page.locator('.gallery-mosaic__open').last().scrollIntoViewIfNeeded();
  const [
    shortManagerNavBox,
    shortGalleryRowBox,
    shortUndoBox,
    shortTrayBox,
    shortGalleryPosition,
    shortUndoStyle,
    shortTrayStyle,
  ] = await Promise.all([
    shortManagerNav.boundingBox(),
    shortGalleryRow.boundingBox(),
    shortUndo.boundingBox(),
    shortTray.boundingBox(),
    shortGalleryRow.evaluate((element) => getComputedStyle(element).position),
    shortUndo.evaluate((element) => {
      const style = getComputedStyle(element);
      return { maxHeight: style.maxHeight, overflowY: style.overflowY };
    }),
    shortTray.evaluate((element) => {
      const style = getComputedStyle(element);
      return { position: style.position, maxHeight: style.maxHeight, overflowY: style.overflowY };
    }),
  ]);
  if (!shortManagerNavBox || !shortGalleryRowBox || !shortUndoBox || !shortTrayBox) {
    throw new Error('The 320 by 568 state requires Manager, Gallery, Undo, and tray bounds.');
  }
  expect.soft(shortGalleryPosition, 'Gallery controls unstick at 320 by 568').toBe('static');
  expect.soft(shortTrayStyle.position, 'selection tray returns to document flow at 320 by 568').toBe('static');
  expect.soft(shortUndoStyle.overflowY, 'Undo has a reachable constrained-height scroll surface').toBe('auto');
  expect.soft(shortTrayStyle.overflowY, 'selection tray has a reachable constrained-height scroll surface').toBe('auto');
  expect.soft(Number.parseFloat(shortUndoStyle.maxHeight), 'Undo has its 116px constrained-height budget')
    .toBeCloseTo(116, 5);
  expect.soft(Number.parseFloat(shortTrayStyle.maxHeight), 'tray consumes the remaining 263px safe-height budget')
    .toBeCloseTo(263, 5);
  expect.soft(await boxesIntersect(shortGalleryRow, shortTray), 'Gallery controls and tray at 320 by 568')
    .toBe(false);
  expect.soft(await boxesIntersect(shortUndo, shortTray), 'Undo and tray at 320 by 568').toBe(false);
  expect(await boxesIntersect(shortManagerNav, shortUndo), 'Manager navigation and Undo at 320 by 568').toBe(false);
  expect(await boxesIntersect(shortManagerNav, shortTray), 'Manager navigation and tray at 320 by 568').toBe(false);

  const shortDestinations = shortManagerNav.locator('button');
  expect(await shortDestinations.count(), 'all Manager destinations remain rendered at 320 by 568').toBe(6);
  for (let index = 0; index < await shortDestinations.count(); index += 1) {
    const control = shortDestinations.nth(index);
    await control.focus();
    await expect(control).toBeFocused();
    const controlBox = await control.boundingBox();
    if (!controlBox) throw new Error(`Manager destination ${index + 1} requires short-height bounds.`);
    expect(controlBox.y, `Manager destination ${index + 1} starts inside the nav at 320 by 568`)
      .toBeGreaterThanOrEqual(shortManagerNavBox.y - GEOMETRY_TOLERANCE);
    expect(controlBox.y + controlBox.height, `Manager destination ${index + 1} ends inside the nav at 320 by 568`)
      .toBeLessThanOrEqual(shortManagerNavBox.y + shortManagerNavBox.height + GEOMETRY_TOLERANCE);
  }

  const shortGalleryControls = shortGalleryRow.locator('button');
  const libraryMode = shortGalleryRow.getByRole('button', { name: 'Library' });
  const [shortManagerOffset, shortUndoDock, shortGalleryRowMargin, shortGalleryControlMargins] =
    await shortGalleryRow.evaluate((element) => {
      const shell = element.closest('.manager-shell');
      if (!shell) throw new Error('Short-height Gallery controls require the Manager shell.');
      const shellStyle = getComputedStyle(shell);
      return [
        Number.parseFloat(shellStyle.getPropertyValue('--manager-sticky-offset')),
        Number.parseFloat(shellStyle.getPropertyValue('--manager-short-undo-dock')),
        Number.parseFloat(getComputedStyle(element).scrollMarginTop),
        Array.from(element.querySelectorAll('button')).map((control) =>
          Number.parseFloat(getComputedStyle(control).scrollMarginTop)),
      ] as const;
    });
  const shortGalleryDockMargin = shortManagerOffset + shortUndoDock;
  expect.soft(shortGalleryRowMargin, 'Gallery row consumes the Manager plus Undo dock at 320 by 568')
    .toBeCloseTo(shortGalleryDockMargin, 5);
  expect.soft(shortGalleryControlMargins, 'Gallery mode controls consume the Manager plus Undo dock at 320 by 568')
    .toEqual(Array.from({ length: await shortGalleryControls.count() }, () => shortGalleryDockMargin));

  await page.evaluate(() => {
    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, document.documentElement.scrollHeight);
    document.documentElement.style.scrollBehavior = previousScrollBehavior;
  });
  const [obstructedLibraryBox, obstructingUndoBox] = await Promise.all([
    libraryMode.boundingBox(),
    shortUndo.boundingBox(),
  ]);
  if (!obstructedLibraryBox || !obstructingUndoBox) {
    throw new Error('The native Gallery focus path requires an initially obstructed control and visible Undo.');
  }
  expect(obstructedLibraryBox.y + obstructedLibraryBox.height, 'Library starts above the fixed Undo dock')
    .toBeLessThanOrEqual(obstructingUndoBox.y + obstructingUndoBox.height);

  await libraryMode.evaluate((element) => {
    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    element.scrollIntoView({ block: 'start', inline: 'nearest' });
    element.focus({ preventScroll: true });
    document.documentElement.style.scrollBehavior = previousScrollBehavior;
  });
  await expect(libraryMode).toBeFocused();
  const [focusedGalleryRowBox, libraryModeBox, visibleUndoBox] = await Promise.all([
    shortGalleryRow.boundingBox(),
    libraryMode.boundingBox(),
    shortUndo.boundingBox(),
  ]);
  if (!focusedGalleryRowBox || !libraryModeBox || !visibleUndoBox) {
    throw new Error('Focused short-height Gallery controls require row, control, and Undo bounds.');
  }
  expect(focusedGalleryRowBox.y, 'start-aligned Gallery row starts below Undo at 320 by 568')
    .toBeGreaterThanOrEqual(visibleUndoBox.y + visibleUndoBox.height - GEOMETRY_TOLERANCE);
  expect(focusedGalleryRowBox.y + focusedGalleryRowBox.height, 'start-aligned Gallery row ends inside the 568 viewport')
    .toBeLessThanOrEqual(568 + GEOMETRY_TOLERANCE);
  expect(libraryModeBox.y, 'focused Gallery mode starts below Undo at 320 by 568')
    .toBeGreaterThanOrEqual(visibleUndoBox.y + visibleUndoBox.height - GEOMETRY_TOLERANCE);
  expect(libraryModeBox.y + libraryModeBox.height, 'focused Gallery mode ends inside the 568 viewport')
    .toBeLessThanOrEqual(568 + GEOMETRY_TOLERANCE);
  await expectTouchTargets(page, '.gallery-control-row button', 'Gallery controls at 320 by 568');
  for (let index = 0; index < await shortGalleryControls.count(); index += 1) {
    const control = shortGalleryControls.nth(index);
    await control.evaluate((element) => element.focus({ preventScroll: true }));
    await expect(control).toBeFocused();
    const [controlBox, surfaceBox] = await Promise.all([control.boundingBox(), shortGalleryRow.boundingBox()]);
    if (!controlBox || !surfaceBox) throw new Error(`Gallery control ${index + 1} needs short-height bounds.`);
    expect(controlBox.y, `Gallery control ${index + 1} starts below Undo at 320 by 568`)
      .toBeGreaterThanOrEqual(visibleUndoBox.y + visibleUndoBox.height - GEOMETRY_TOLERANCE);
    expect(controlBox.y, `Gallery control ${index + 1} starts inside its row at 320 by 568`)
      .toBeGreaterThanOrEqual(surfaceBox.y - GEOMETRY_TOLERANCE);
    expect(controlBox.y + controlBox.height, `Gallery control ${index + 1} ends inside its row at 320 by 568`)
      .toBeLessThanOrEqual(surfaceBox.y + surfaceBox.height + GEOMETRY_TOLERANCE);
    expect(controlBox.y + controlBox.height, `Gallery control ${index + 1} ends inside the 568 viewport`)
      .toBeLessThanOrEqual(568 + GEOMETRY_TOLERANCE);
  }
  const shortAudienceSummary = shortGalleryRow.locator('.gallery-audience-summary');
  await expect(shortAudienceSummary).toBeVisible();
  const [audienceSummaryBox, visibleGalleryRowBox] = await Promise.all([
    shortAudienceSummary.boundingBox(),
    shortGalleryRow.boundingBox(),
  ]);
  if (!audienceSummaryBox || !visibleGalleryRowBox) {
    throw new Error('The short-height audience summary requires row and content bounds.');
  }
  expect(audienceSummaryBox.y, 'audience summary starts inside the Gallery row at 320 by 568')
    .toBeGreaterThanOrEqual(visibleGalleryRowBox.y - GEOMETRY_TOLERANCE);
  expect(audienceSummaryBox.y + audienceSummaryBox.height, 'audience summary ends inside the Gallery row at 320 by 568')
    .toBeLessThanOrEqual(visibleGalleryRowBox.y + visibleGalleryRowBox.height + GEOMETRY_TOLERANCE);
  expect(audienceSummaryBox.y + audienceSummaryBox.height, 'audience summary ends inside the 568 viewport')
    .toBeLessThanOrEqual(568 + GEOMETRY_TOLERANCE);

  const undoMessage = shortUndo.locator('.album-undo__message');
  await expect(undoMessage).toHaveText('1 photo picked for Album. Nothing was published.');
  await undoMessage.scrollIntoViewIfNeeded();
  await expect(undoMessage).toBeVisible();
  const [undoMessageBox, undoMessageSurfaceBox, undoMessageStyle] = await Promise.all([
    undoMessage.boundingBox(),
    shortUndo.boundingBox(),
    undoMessage.evaluate((element) => {
      const style = getComputedStyle(element);
      return { display: style.display, textOverflow: style.textOverflow };
    }),
  ]);
  if (!undoMessageBox || !undoMessageSurfaceBox) {
    throw new Error('The complete Undo message requires visible short-height bounds.');
  }
  expect(undoMessageStyle.display, 'Undo message is not hidden at 320 by 568').not.toBe('none');
  expect(undoMessageStyle.textOverflow, 'Undo message is not ellipsized at 320 by 568').not.toBe('ellipsis');
  expect(undoMessageBox.y, 'Undo message starts inside its scroll surface at 320 by 568')
    .toBeGreaterThanOrEqual(undoMessageSurfaceBox.y - GEOMETRY_TOLERANCE);
  expect(undoMessageBox.y + undoMessageBox.height, 'Undo message ends inside its scroll surface at 320 by 568')
    .toBeLessThanOrEqual(undoMessageSurfaceBox.y + undoMessageSurfaceBox.height + GEOMETRY_TOLERANCE);
  for (let index = 0; index < await shortUndo.locator('button').count(); index += 1) {
    const control = shortUndo.locator('button').nth(index);
    await control.scrollIntoViewIfNeeded();
    await control.focus();
    await expect(control).toBeFocused();
    const [controlBox, surfaceBox] = await Promise.all([control.boundingBox(), shortUndo.boundingBox()]);
    if (!controlBox || !surfaceBox) throw new Error(`Undo control ${index + 1} needs short-height bounds.`);
    expect(controlBox.height, `Undo control ${index + 1} height at 320 by 568`).toBeGreaterThanOrEqual(44);
    expect(controlBox.y, `Undo control ${index + 1} starts inside Undo at 320 by 568`)
      .toBeGreaterThanOrEqual(surfaceBox.y - GEOMETRY_TOLERANCE);
    expect(controlBox.y + controlBox.height, `Undo control ${index + 1} ends inside Undo at 320 by 568`)
      .toBeLessThanOrEqual(surfaceBox.y + surfaceBox.height + GEOMETRY_TOLERANCE);
  }

  await shortTray.evaluate((element) => {
    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    element.scrollIntoView({ block: 'end' });
    document.documentElement.style.scrollBehavior = previousScrollBehavior;
  });
  const [flowTrayBox, fixedUndoBox, fixedManagerNavBox] = await Promise.all([
    shortTray.boundingBox(),
    shortUndo.boundingBox(),
    shortManagerNav.boundingBox(),
  ]);
  if (!flowTrayBox || !fixedUndoBox || !fixedManagerNavBox) {
    throw new Error('The short-height flow tray requires tray, Undo, and Manager bounds.');
  }
  expect(flowTrayBox.y, 'flow tray starts below Undo at 320 by 568')
    .toBeGreaterThanOrEqual(fixedUndoBox.y + fixedUndoBox.height - GEOMETRY_TOLERANCE);
  expect(flowTrayBox.y + flowTrayBox.height, 'flow tray preserves its bottom safe-area gap at 320 by 568')
    .toBeLessThanOrEqual(568 - 12 + GEOMETRY_TOLERANCE);
  expect(await boxesIntersect(shortUndo, shortTray), 'scrolled Undo and tray at 320 by 568').toBe(false);
  expect(await boxesIntersect(shortManagerNav, shortTray), 'scrolled Manager navigation and tray at 320 by 568')
    .toBe(false);
  for (let index = 0; index < await shortTray.locator('button').count(); index += 1) {
    const control = shortTray.locator('button').nth(index);
    await control.scrollIntoViewIfNeeded();
    await control.focus();
    await expect(control).toBeFocused();
    const [controlBox, surfaceBox] = await Promise.all([control.boundingBox(), shortTray.boundingBox()]);
    if (!controlBox || !surfaceBox) throw new Error(`Tray control ${index + 1} needs short-height bounds.`);
    expect(controlBox.height, `tray control ${index + 1} height at 320 by 568`).toBeGreaterThanOrEqual(44);
    expect(controlBox.y, `tray control ${index + 1} starts inside the tray at 320 by 568`)
      .toBeGreaterThanOrEqual(surfaceBox.y - GEOMETRY_TOLERANCE);
    expect(controlBox.y + controlBox.height, `tray control ${index + 1} ends inside the tray at 320 by 568`)
      .toBeLessThanOrEqual(surfaceBox.y + surfaceBox.height + GEOMETRY_TOLERANCE);
  }
  await expect(shortTrayCopy).toHaveText(
    'Pick changes Album membership only. Remove from Album keeps every delivered photo in Library; neither action publishes to the Guest gallery.',
  );
  await shortTrayCopy.scrollIntoViewIfNeeded();
  await expect(shortTrayCopy).toBeVisible();
  const shortTrayCopyStyle = await shortTrayCopy.evaluate((element) => {
    const style = getComputedStyle(element);
    return { display: style.display, textOverflow: style.textOverflow };
  });
  expect(shortTrayCopyStyle.display, 'tray consequence copy is not hidden at 320 by 568').not.toBe('none');
  expect(shortTrayCopyStyle.textOverflow, 'tray consequence copy is not ellipsized at 320 by 568')
    .not.toBe('ellipsis');
  const shortFragments = await shortTrayCopy.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return Array.from(range.getClientRects()).map((rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    })).filter((rect) => rect.width > 0 && rect.height > 0);
  });
  const visibleTrayBox = await shortTray.boundingBox();
  if (!visibleTrayBox) throw new Error('The short-height tray copy requires tray bounds.');
  for (const [index, fragment] of shortFragments.entries()) {
    expect(fragment.x, `short-height tray fragment ${index + 1} starts inside the tray`)
      .toBeGreaterThanOrEqual(visibleTrayBox.x - GEOMETRY_TOLERANCE);
    expect(fragment.x + fragment.width, `short-height tray fragment ${index + 1} ends inside the tray`)
      .toBeLessThanOrEqual(visibleTrayBox.x + visibleTrayBox.width + GEOMETRY_TOLERANCE);
    expect(fragment.y, `short-height tray fragment ${index + 1} starts inside the visible tray scroller`)
      .toBeGreaterThanOrEqual(visibleTrayBox.y - GEOMETRY_TOLERANCE);
    expect(fragment.y + fragment.height, `short-height tray fragment ${index + 1} ends inside the visible tray scroller`)
      .toBeLessThanOrEqual(visibleTrayBox.y + visibleTrayBox.height + GEOMETRY_TOLERANCE);
  }
  const shortDocument = await measureDocument(page);
  expect(shortDocument.scrollWidth, 'document at 320 by 568')
    .toBeLessThanOrEqual(shortDocument.clientWidth + GEOMETRY_TOLERANCE);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('button', { name: /^Album \(1\)$/u }).click();
  await expect(page.getByRole('heading', { name: 'Album', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a section' })).toBeVisible();
  await expectTouchTargets(page, '.gallery-album button', 'Album controls at 390');

  await page.getByRole('button', { name: 'Guest gallery' }).click();
  await expect(page.getByRole('heading', { name: 'Gallery', exact: true })).toBeVisible();
  await expect(page.getByText(/Publish and Hide change what event guests see/u)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Shared' })).toHaveCount(0);
  await expectTouchTargets(page, '.gallery-shared button', 'Guest-gallery controls at 390');
  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth, 'Gallery document at 390')
    .toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

const RTL_GUESTBOOK_BODY = `${'ذكرى جميلة من هذا اليوم — '.repeat(18)}🌿`.slice(0, 500);
const RTL_MANAGER_NOTE: ManagerGuestbookItem = {
  id: 'guestbook-rtl',
  source: 'guest_note',
  guestName: 'ليلى'.repeat(20),
  body: RTL_GUESTBOOK_BODY,
  createdAt: '2026-09-19T20:00:00Z',
  state: 'pending',
  visibility: 'author_only',
};

test('Manager Guestbook contains maximum Unicode content at phone, desktop, and zoom-equivalent widths', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages,
    guestbook: { items: [RTL_MANAGER_NOTE] },
  });
  await page.goto(managerUrl);

  for (const { width, height, label } of [
    { width: 320, height: 844, label: '320 phone and 400% zoom equivalent' },
    { width: 390, height: 844, label: '390 phone' },
    { width: 1280, height: 900, label: 'representative desktop' },
    { width: 640, height: 450, label: '200% zoom equivalent' },
  ]) {
    await page.setViewportSize({ width, height });
    await destination(page, 'Guestbook').click();
    await expect(page.getByRole('heading', { name: 'Guestbook from the day' })).toBeVisible();
    const entry = page.locator('.manager-guestbook__entry');
    await expect(entry.locator('h3')).toHaveAttribute('dir', 'auto');
    await expect(entry.locator('> p')).toHaveAttribute('dir', 'auto');
    const body = await measureOverflow(entry.locator('> p'));
    expect(body.scrollWidth, `${label} body wraps`).toBeLessThanOrEqual(body.clientWidth + 1);
    for (const control of await page.locator('.manager-guestbook button:visible').all()) {
      const target = await measureTarget(control);
      expect(target.width, `${label} control width`).toBeGreaterThanOrEqual(44);
      expect(target.height, `${label} control height`).toBeGreaterThanOrEqual(44);
    }
    await expectContained(page, width);
  }
});

test('keyboard-only Manager moderation keeps focus and scroll stable after confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseAction!: () => void;
  const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
  const pendingNotes = Array.from({ length: 5 }, (_, index): ManagerGuestbookItem => ({
    ...RTL_MANAGER_NOTE,
    id: `guestbook-pending-${index + 1}`,
    guestName: `Guest ${index + 1}`,
  }));
  await stubManagerRoutes(page, {
    mediaPages,
    guestbook: { items: pendingNotes, actionGate },
  });
  await page.goto(managerUrl);
  const guestbook = destination(page, 'Guestbook');
  await guestbook.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Guestbook from the day' });
  await expect(panel).toBeVisible();
  const share = panel.getByRole('button', { name: 'Share', exact: true }).first();
  await share.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Sharing…' })).toBeVisible();
  await page.evaluate(() => window.scrollTo({ top: 450, behavior: 'instant' }));
  const scrollDuringRequest = await page.evaluate(() => window.scrollY);
  expect(scrollDuringRequest).toBeGreaterThan(100);
  releaseAction();
  await expect(page.locator('.manager-guestbook__list > li')).toHaveCount(4);
  await expect(page.getByText('Guestbook entry updated.')).toBeAttached();
  await expect(panel.getByRole('button', { name: 'Share', exact: true }).first()).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollDuringRequest);
});

test('gallery-off keeps published captions out of Shared and labels them precisely in Hidden', async ({ page }) => {
  const caption: ManagerGuestbookItem = {
    id: 'caption-gallery-off',
    source: 'photo_caption',
    mediaId: 'media-gallery-off',
    guestName: 'Avery',
    body: 'A caption held private while the gallery is off.',
    createdAt: '2026-09-19T19:00:00Z',
    state: 'published',
    visibility: 'author_only',
    previewAvailable: true,
  };
  await stubManagerRoutes(page, {
    event: { galleryVisible: false },
    mediaPages,
    guestbook: { items: [caption] },
  });
  await page.goto(managerUrl);
  await destination(page, 'Guestbook').click();
  await expect(page.getByText('Photo captions with a saved Published state are not currently visible to event guests while the Guest gallery is off.')).toBeVisible();
  await expect(page.locator('.manager-guestbook__list > li')).toHaveCount(0);
  await page.getByRole('button', { name: /Hidden/u }).click();
  await expect(page.getByText('Not currently visible to event guests')).toBeVisible();
  await expect(page.locator('.manager-guestbook__list > li')).toHaveCount(1);
});

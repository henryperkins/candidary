import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { MANAGER_MEDIA_PAGE_SIZE, MAX_EVENT_BYTES, MAX_EVENT_MEDIA } from '../../shared/constants';
import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { LONG_FILENAME, UNBROKEN_NOTE, makeMedia } from './fixtures/ui-data';
import {
  measureContrast,
  measureDocument,
  measureGridTracks,
  measureOverflow,
  measureSeparation,
  measureTarget,
  measureViewportEscapes,
} from './helpers/geometry';

const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;
const DESTINATIONS = ['Intake', 'Gallery', 'Notes', 'Share', 'Settings'] as const;
// The compact rail band: 761 opens it and 1100 is the last width before the wide rails return.
const RAIL_WIDTHS = [761, 768, 780, 860, 1024, 1100];
// 1134 is the first width the old fixed tracks fit inside; everything under it pushed the page sideways.
const WIDE_WIDTHS = [1101, 1120, 1133, 1134, 1440];
// The stacked phone modes: one media column below 431, two from 431 up to the compact rail.
const ONE_COLUMN_WIDTHS = [320, 360, 390, 430];
const TWO_COLUMN_WIDTHS = [431, 470, 760];
// The nav label is a destination, not decoration; below this it is an unreadable smudge on a phone.
const MIN_LABEL_TEXT = 10;
const MIN_CONTRAST = 4.5;
const TOUCH_MINIMUM = 44;
const NOTE = {
  id: 'message-a',
  guestName: 'Rowan',
  body: 'To a lifetime of noticing the little things.',
  moderationStatus: 'approved' as const,
  createdAt: '2026-09-19T20:00:00Z',
};
// A count renders only when there is something to count, so both counted destinations carry one.
const mediaPages = { first: { media: makeMedia(2), nextCursor: null } };
const managerFixture = { mediaPages, messages: [NOTE], event: { storedMediaCount: 2 } };

// The Intake and Notes buttons carry a count, so their accessible name is not the destination alone.
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

test('manager navigation keeps every destination labelled across the compact rail band', async ({ page }) => {
  await openManager(page);

  for (const width of RAIL_WIDTHS) {
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

    // Five buttons of at most 52px plus four 5px gaps is 280; a stretched rail measures over 500.
    const destinations = await measureTarget(page.locator('.manager-nav nav'));
    expect(destinations.height, `destination block height at ${width}`).toBeLessThanOrEqual(340);
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

test('manager navigation keeps an inactive section count visible on both sides of the rail', async ({ page }) => {
  await openManager(page);
  const notes = destination(page, 'Notes');
  const count = notes.locator('.manager-nav__count');

  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(notes, `Notes is the inactive destination at ${width}`).toHaveAttribute('aria-pressed', 'false');
    await expect(count, `Notes count rendered at ${width}`).toBeVisible();
    await expect(count).toHaveText('1');

    const box = await measureTarget(count);
    expect(box.width, `Notes count width at ${width}`).toBeGreaterThan(0);
    expect(box.height, `Notes count height at ${width}`).toBeGreaterThan(0);

    const fontSize = await count.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(fontSize, `Notes count text size at ${width}`).toBeGreaterThan(0);
  }
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
  const heading = page.getByRole('heading', { name: 'Share the photo drop' });
  await expect(heading).toBeVisible();
  await expect.poll(
    () => page.evaluate(() => window.scrollY),
    { message: 'the new section starts at its own top' },
  ).toBeLessThanOrEqual(1);

  // The header is sticky, so "at the top" has to mean below it rather than underneath it.
  expect(await measureSeparation(page.locator('.manager-nav'), heading), 'heading clears the sticky nav')
    .toBeGreaterThan(0);
});

test('a long unbroken guest note stays inside the manager at every width', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages,
    messages: [{ ...NOTE, body: UNBROKEN_NOTE }],
    event: { storedMediaCount: 2 },
  });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await destination(page, 'Notes').click();
  const note = page.locator('.manager-messages p');
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
  const job = {
    id: 'export-a', state: 'ready', snapshotAt: '2026-09-20T09:00:00Z',
    mediaCount: 2, totalBytes: 256, attempt: 1, partCount: 1, expiresAt: '2026-09-27T09:00:00Z',
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

  // Every media-grid mode: one phone column, the 431 two-column band, and the three-column rail layout.
  for (const width of [390, 431, 470, 1200]) {
    await page.setViewportSize({ width, height: 900 });

    await destination(page, 'Intake').click();
    await expectTouchTargets(page, '.intake-search .button', `intake filter at ${width}`);
    await expectTouchTargets(page, '.moderation-grid article:first-of-type .intake-card-actions a', `intake download at ${width}`);
    await expectTouchTargets(page, '.moderation-grid article:first-of-type .intake-card-actions button', `intake card control at ${width}`);

    await destination(page, 'Gallery').click();
    await expectTouchTargets(page, '.filter-tabs button', `publication filter at ${width}`);
    await expectTouchTargets(page, '.bulk-bar .button', `bulk control at ${width}`);
    await expectTouchTargets(page, '.moderation-grid article:first-of-type button', `gallery card control at ${width}`);

    // The card clips its own corners, so a control pushed past its edge still measures 44x44 and still
    // stays inside the viewport. Only the row that holds them reports that it ran out of width.
    const actions = page.locator('.moderation-grid article:first-of-type .intake-card-actions');
    const actionRow = await measureOverflow(actions);
    expect(actionRow.scrollWidth, `card controls fit their row at ${width}`)
      .toBeLessThanOrEqual(actionRow.clientWidth + 1);

    await destination(page, 'Notes').click();
    await expectTouchTargets(page, '.manager-messages .button', `note control at ${width}`);

    await destination(page, 'Share').click();
    const panel = page.locator(width < 761 ? '.manager-export-panel--share' : '.manager-export-panel--utility');
    const links = panel.locator('.export-links a');
    if (await links.count() === 0) await panel.getByRole('button', { name: 'Get download links' }).click();
    await expect(links.first()).toBeVisible();
    await expectTouchTargets(page, `${width < 761 ? '.manager-export-panel--share' : '.manager-export-panel--utility'} .export-links a`, `export link at ${width}`);

    await expectContained(page, width);
  }
});

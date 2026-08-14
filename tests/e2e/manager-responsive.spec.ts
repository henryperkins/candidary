import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { MANAGER_MEDIA_PAGE_SIZE, MAX_EVENT_BYTES, MAX_EVENT_MEDIA } from '../../shared/constants';
import type { ManagerGuestbookItem } from '../../shared/contracts';
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
const DESTINATIONS = ['Intake', 'RSVP', 'Gallery', 'Guestbook', 'Share', 'Settings'] as const;
// The compact rail band: 761 opens it and 1100 is the last width before the wide rails return.
const RAIL_WIDTHS = [761, 768, 780, 860, 1024, 1100];
// 1134 is the first width the old fixed tracks fit inside; everything under it pushed the page sideways.
const WIDE_WIDTHS = [1101, 1120, 1133, 1134, 1440];
// The stacked phone mode, which is now one band rather than two. The second media column used to
// arrive at 431 — a breakpoint that excluded every shipping iPhone: 390 (14/15/16), 393 (Pro), 402
// (16 Pro) and 430 (Pro Max) all sit below it, so the phones people actually hold got one card per
// row. The grid is a two-up contact sheet everywhere under the compact rail, and 431 means nothing.
const STACKED_WIDTHS = [320, 360, 390, 430, 431, 470, 760];
// Manager destinations are controls, so their labels follow the binding 14–16px control-text band.
const MIN_LABEL_TEXT = 14;
const MIN_COUNT_TEXT = 12;
const MIN_CONTRAST = 4.5;
const TOUCH_MINIMUM = 44;
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

test('manager shell and media grid turn over exactly at their breakpoints', async ({ page }) => {
  await openManager(page);
  const shell = page.locator('.manager-shell--intake');
  const mediaGrid = page.locator('.moderation-grid');

  // Under 761 the manager is the stacked layout, so the shell resolves no grid tracks at all, and the
  // contact sheet inside it is two-up at every one of those widths — 320 included.
  for (const width of STACKED_WIDTHS) {
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

// Six destinations across 390px leave each one 65px, and the badge is placed for one or two digits, so
// on a phone the pill covers the icon it belongs to. Below 761 it is a dot and the figure is carried by
// the destination's own `aria-label`; from 761 the rail has the room and prints the number. Either way
// the count has to reach a host, so this measures both halves of that promise across the breakpoint.
test('manager navigation keeps the unresolved Guestbook count reaching the host on both sides of the rail', async ({ page }) => {
  await openManager(page);
  const guestbook = destination(page, 'Guestbook');
  const count = guestbook.locator('.manager-nav__count');

  for (const width of [320, 390, 760, 761, 1101]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(guestbook, `Guestbook is the inactive destination at ${width}`).toHaveAttribute('aria-pressed', 'false');
    // The figure is in the destination's own name at every width, which is the half that has to
    // survive the badge becoming a dot.
    await expect(guestbook, `Guestbook count announced at ${width}`).toHaveAccessibleName(/Guestbook 1\b/u);

    await expect(count, `Guestbook badge rendered at ${width}`).toBeVisible();
    const box = await measureTarget(count);
    expect(box.width, `Guestbook badge width at ${width}`).toBeGreaterThan(0);
    expect(box.height, `Guestbook badge height at ${width}`).toBeGreaterThan(0);

    const fontSize = await count.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    if (width >= 761) {
      await expect(count, `Guestbook badge prints its digits at ${width}`).toHaveText('1');
      expect(fontSize, `Guestbook count text size at ${width}`).toBeGreaterThanOrEqual(MIN_COUNT_TEXT);
    } else {
      // A dot, not a number: no glyph is drawn, and it stays clear of the icon it marks.
      expect(fontSize, `Guestbook badge draws no text at ${width}`).toBe(0);
      expect(box.width, `Guestbook badge is a dot at ${width}`).toBeLessThanOrEqual(12);
    }
  }
});

// The badge is a fixed-size box no containment assertion can reach: the digits that leave it are an
// anonymous box, not an element, so `measureViewportEscapes` and the document scan both see nothing.
// Only the badge's own scroll width reports it, and only the documented cap makes it happen. Below 761
// the digits are gone and the dot has nothing to overflow with, so the whole cap is measured where it
// is still drawn — and the accessible name is what carries it everywhere else.
test('the intake count badge holds the whole photo cap wherever it prints one', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages,
    messages: [NOTE],
    event: { storedMediaCount: MAX_EVENT_MEDIA, storedBytes: MAX_EVENT_BYTES },
  });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  const count = destination(page, 'Intake').locator('.manager-nav__count');
  await expect(count).toHaveText(String(MAX_EVENT_MEDIA));
  await expect(destination(page, 'Intake')).toHaveAccessibleName(
    new RegExp(`${MAX_EVENT_MEDIA.toLocaleString('en-US')} photos`, 'u'),
  );

  for (const width of [...STACKED_WIDTHS, ...RAIL_WIDTHS, ...WIDE_WIDTHS]) {
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
  await page.getByLabel('Filter by guest name').fill('Rowan');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeVisible();

  // The stacked contact sheet at three of its widths, then the three-column wide layout. 431 is no
  // longer a turnover — it is kept only because a control that fits at 390 and 470 has to fit between.
  for (const width of [390, 431, 470, 1200]) {
    await page.setViewportSize({ width, height: 900 });

    await destination(page, 'Intake').click();
    await expectTouchTargets(page, '.intake-search .button', `intake filter at ${width}`);
    await expectTouchTargets(page, '.intake-search .text-button', `intake clear at ${width}`);
    await expectTouchTargets(page, '.moderation-grid article:first-of-type .intake-card-actions a', `intake download at ${width}`);
    await expectTouchTargets(page, '.moderation-grid article:first-of-type .intake-card-actions button', `intake card control at ${width}`);

    await destination(page, 'Gallery').click();
    await expectTouchTargets(page, '.filter-tabs button', `publication filter at ${width}`);
    await expectTouchTargets(page, '.bulk-bar .button', `bulk control at ${width}`);
    // Below 761 the contact sheet's one tap target is selection and the four per-photo actions belong
    // to the chosen card, so the card has to be chosen before they can be measured. Selecting also
    // sends the bulk bar to the foot of the viewport, which is the state a host publishes from.
    await page.locator('.moderation-grid article:first-of-type .intake-select').click();
    await expectTouchTargets(page, '.moderation-grid article:first-of-type button', `gallery card control at ${width}`);

    // The card clips its own corners, so a control pushed past its edge still measures 44x44 and still
    // stays inside the viewport. Only the row that holds them reports that it ran out of width.
    const actions = page.locator('.moderation-grid article:first-of-type .intake-card-actions');
    const actionRow = await measureOverflow(actions);
    expect(actionRow.scrollWidth, `card controls fit their row at ${width}`)
      .toBeLessThanOrEqual(actionRow.clientWidth + 1);

    await destination(page, 'Guestbook').click();
    await expectTouchTargets(page, '.manager-guestbook__entry .button', `Guestbook control at ${width}`);

    await destination(page, 'Share').click();
    const panel = page.locator(width < 761 ? '.manager-export-panel--share' : '.manager-export-panel--utility');
    const links = panel.locator('.export-links a');
    if (await links.count() === 0) await panel.getByRole('button', { name: 'Get download links' }).click();
    await expect(links.first()).toBeVisible();
    await expectTouchTargets(page, `${width < 761 ? '.manager-export-panel--share' : '.manager-export-panel--utility'} .export-links a`, `export link at ${width}`);

    await expectContained(page, width);
  }
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

test('gallery-off keeps published captions out of Shared and labels them in Hidden', async ({ page }) => {
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
  await expect(page.getByText('Photo captions are not visible to guests while the gallery is off.')).toBeVisible();
  await expect(page.locator('.manager-guestbook__list > li')).toHaveCount(0);
  await page.getByRole('button', { name: /Hidden/u }).click();
  await expect(page.getByText('Published · gallery off')).toBeVisible();
  await expect(page.locator('.manager-guestbook__list > li')).toHaveCount(1);
});

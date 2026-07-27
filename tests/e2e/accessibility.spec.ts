import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

import { EVENT_FIXTURE } from './fixtures/routes';
import { measureContrast, measureDocument, measureSeparation, measureTarget } from './helpers/geometry';

// 320 is the narrowest supported phone; 768 is the tablet side of the public header's own boundary.
const HEADER_WIDTHS = [320, 768];
// The five manager destinations are unchanged and the public header keeps exactly these exits: the
// count is asserted so neither a hidden one nor an added one can pass unnoticed.
const HEADER_EXITS = [
  { path: '/', names: ['Candidary home', 'Create an event'] },
  { path: '/create', names: ['Candidary home', 'Back home'] },
];

function animationName(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).animationName);
}

function outline(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
}

test('public actions and creation fields are keyboard reachable with named landmarks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Candidary home' })).toBeFocused();
  // The header exit is now reachable at every width, so the tab order no longer varies by viewport.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Create an event', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Create your event', exact: true })).toBeFocused();
  await page.goto('/create');
  await expect(page.getByLabel('Event name')).toHaveAttribute('required', '');
  await expect(page.getByLabel('Event date')).toHaveAttribute('type', 'date');
  await expect(page.getByLabel('Welcome message')).toHaveAttribute('maxlength', '500');
});

test('every public header exit stays visible and mobile-sized across the width matrix', async ({ page }) => {
  for (const width of HEADER_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    for (const { path, names } of HEADER_EXITS) {
      await page.goto(path);
      const header = page.getByRole('banner');
      // Hiding an exit strands the visitor; adding one is unapproved navigation. Both fail here.
      await expect(header.getByRole('link'), `${path} header exits at ${width}`).toHaveCount(names.length);

      for (const name of names) {
        const link = header.getByRole('link', { name, exact: true });
        await expect(link, `${name} on ${path} at ${width}`).toBeVisible();
        const target = await measureTarget(link);
        expect(target.width, `${name} width on ${path} at ${width}`).toBeGreaterThanOrEqual(44);
        expect(target.height, `${name} height on ${path} at ${width}`).toBeGreaterThanOrEqual(44);
      }

      // Two exits that touch are one mis-tap apart, and 320 is where they come closest.
      const separation = await measureSeparation(header.getByRole('link').first(), header.getByRole('link').last());
      expect(separation, `header exits stay apart on ${path} at ${width}`).toBeGreaterThanOrEqual(8);

      const documentSize = await measureDocument(page);
      expect(documentSize.scrollWidth, `${path} contained at ${width}`)
        .toBeLessThanOrEqual(documentSize.clientWidth + 1);
    }
  }
});

test('cover photo focus lands on the control the host can actually see', async ({ page }) => {
  await page.goto('/create');
  const field = page.locator('.cover-field');
  const input = page.locator('.cover-field__input');
  await expect(field).toBeVisible();
  await expect(input).toHaveAttribute('type', 'file');

  const target = await measureTarget(field);
  expect(target.width, 'cover control width').toBeGreaterThanOrEqual(44);
  expect(target.height, 'cover control height').toBeGreaterThanOrEqual(44);

  await page.getByLabel('Welcome message').focus();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();

  const visibleRing = await outline(field);
  expect(visibleRing.style, 'the visible cover control draws the focus ring').toBe('solid');
  expect(visibleRing.width, 'focus ring width').toBeGreaterThanOrEqual(2);

  const hiddenRing = await outline(input);
  expect(hiddenRing.style, 'no ring on the control the host cannot see').toBe('none');
  expect(hiddenRing.width).toBe(0);
});

test('guest photo sources have mobile-sized targets and name errors focus the field', async ({ page }) => {
  await page.route('**/api/event/maya-theo', (route) => route.fulfill({ json: { data: { event: {
    id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Help us remember tonight.',
    uploadsEnabled: true, galleryVisible: false, moderationRequired: true,
  }, role: 'guest' }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/contributions', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/messages', (route) => route.fulfill({ json: { data: { items: [] }, requestId: 'r' } }));
  await page.goto('/event/maya-theo');

  const camera = page.getByRole('button', { name: 'Take a photo', exact: true });
  const library = page.getByRole('button', { name: 'Choose recent photos', exact: true });
  for (const target of [camera, library]) {
    await expect.poll(async () => (await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect.poll(async () => (await target.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await camera.click();
  await expect(page.getByLabel('Your name')).toBeFocused();
  await expect(page.getByText('Enter your name before adding photos.')).toHaveAttribute('role', 'alert');
});

test('reduced motion stops every guest spinner instead of racing it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  let releaseEvent = () => {};
  const eventGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
  let releaseBatch = () => {};
  const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
  const base = `**/api/event/${EVENT_FIXTURE.slug}`;

  await page.route(base, async (route) => {
    await eventGate;
    await route.fulfill({ json: { data: { event: EVENT_FIXTURE, role: 'guest' }, requestId: 'r' } });
  });
  await page.route(`${base}/contributions`, (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route(`${base}/messages`, (route) => route.fulfill({ json: { data: { items: [] }, requestId: 'r' } }));
  await page.route(`${base}/uploads/batch`, async (route) => {
    await batchGate;
    const payload = route.request().postDataJSON() as { files: Array<{ idempotencyKey: string }> };
    await route.fulfill({ status: 201, json: { data: { items: payload.files.map(({ idempotencyKey }) => ({
      idempotencyKey, status: 'rejected', error: { message: 'Reception dropped out. Try this photo again.' },
    })) }, requestId: 'r' } });
  });

  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  const appSpinner = page.locator('.spin');
  await expect(appSpinner).toBeVisible();
  expect(await animationName(appSpinner)).toBe('none');
  releaseEvent();

  await page.getByLabel('Your name').fill('Taylor Morgan');
  await page.locator('input[data-photo-source="library"]').setInputFiles({
    name: 'recent.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('recent-photo'),
  });
  await page.getByRole('button', { name: 'Send 1 photo' }).click();

  const cardSpinner = page.locator('.selection-card__spinner svg');
  await expect(cardSpinner).toBeVisible();
  expect(await animationName(cardSpinner)).toBe('none');

  const sendSpinner = page.locator('.send-button svg');
  await expect(sendSpinner).toBeVisible();
  expect(await animationName(sendSpinner)).toBe('none');

  releaseBatch();
  await expect(page.getByRole('button', { name: 'Retry 1 photo' })).toBeVisible();
});

test('manager navigation exposes visible labels, selected state, and mobile-sized targets', async ({ page }) => {
  const event = {
    id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
    uploadsEnabled: true, galleryVisible: false, moderationRequired: true, storedMediaCount: 0, storedBytes: 0,
    guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
  };
  await page.route('**/api/manage/events/event-a', (route) => route.fulfill({ json: { data: { event }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/media*', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/messages', (route) => route.fulfill({ json: { data: { messages: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/exports', (route) => route.fulfill({ json: { data: { exports: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/links', (route) => route.fulfill({ json: { data: { guestLink: 'https://candidary.test/join/guest' }, requestId: 'r' } }));
  await page.goto('/manage/event/event-a');
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();

  const intake = page.getByRole('button', { name: 'Intake', exact: true });
  await expect(intake).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['Intake', 'Gallery', 'Notes', 'Share', 'Settings']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const label = button.locator('.manager-nav__label');
    await expect(label).toBeVisible();
    expect(await label.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(0);
    expect((await label.boundingBox())?.height ?? 0).toBeGreaterThan(0);
    // Measured from the colours the browser resolved, so a token that never reaches the label fails here.
    expect(await measureContrast(label), `${name} label contrast`).toBeGreaterThanOrEqual(4.5);
  }

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(intake).toHaveAttribute('aria-pressed', 'false');
});

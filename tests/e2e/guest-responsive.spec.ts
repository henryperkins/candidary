import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { GuestGuestbookItem } from '../../shared/contracts';
import { EVENT_FIXTURE, eventTheme, stubGuestRoutes } from './fixtures/routes';
import { LONG_FILENAME, LONG_WELCOME, makeMedia } from './fixtures/ui-data';
import {
  measureDocument,
  measureFold,
  measureGridTracks,
  measureOverflow,
  measureSeparation,
  measureTarget,
} from './helpers/geometry';

const KEEPER = { name: LONG_FILENAME, mimeType: 'image/jpeg', buffer: Buffer.from('keeper') };
const REJECT = { name: 'guest-list.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') };

test('RSVP lookup keeps identity, deadline, privacy, and its complete action in the 320 by 568 first viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await stubGuestRoutes(page, {
    event: {
      uploadsEnabled: false,
      phase: 'rsvp-primary',
      rsvpState: 'open',
      rsvpAccess: 'editable',
      rsvpDeadlineAt: '2026-09-05T23:59:59.999Z',
      rsvpDeadlineDate: '2026-09-05',
    },
  });

  await page.goto('/event/maya-theo');
  await expect(page.getByRole('heading', { name: 'Find your household invitation' })).toBeVisible();
  await expect(page.locator('.photo-drop__event')).toHaveText('Maya & Theo · Sep 19');
  await expect(page.getByText('Please RSVP by Sep 5, 2026.')).toBeVisible();
  const name = page.getByLabel('Full name');
  await expect(name).toHaveAttribute('autocomplete', 'name');
  await expect(page.getByText(/We never show or suggest the guest list/u)).toBeVisible();
  const action = page.getByRole('button', { name: 'Find my invitation' });
  const fold = await measureFold(page, action);
  expect(fold.bottom, 'lookup action ends within the first viewport').toBeLessThanOrEqual(fold.fold);
  const target = await measureTarget(action);
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  expect(await page.getByRole('button', { name: 'Take a photo' }).count()).toBe(0);

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

async function stubUploadDelivery(page: Page) {
  const base = `**/api/event/${EVENT_FIXTURE.slug}`;
  await page.route(`${base}/uploads/batch`, async (route) => {
    const payload = route.request().postDataJSON() as { files: Array<{ idempotencyKey: string; mimeType: string }> };
    const origin = new URL(page.url()).origin;
    await route.fulfill({ status: 201, json: { data: { items: payload.files.map((file) => ({
      idempotencyKey: file.idempotencyKey,
      status: 'accepted',
      media: { id: `media-${file.idempotencyKey}`, mimeType: file.mimeType || 'image/jpeg' },
      uploadUrl: `${origin}/direct-upload/${file.idempotencyKey}`,
    })) }, requestId: 'request-a' } });
  });
  await page.route('**/direct-upload/*', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route(`${base}/uploads/*/finalize`, (route) => route.fulfill({
    json: { data: { media: { uploadState: 'stored' } }, requestId: 'request-a' },
  }));
}

test('guest secondary sections stay contained at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubGuestRoutes(page, { gallery: makeMedia(6), contributions: makeMedia(4) });

  await page.goto('/event/maya-theo');
  await page.locator('.event-extra summary').filter({ hasText: 'My deliveries' }).click();
  await expect(page.locator('.contributions li')).toHaveCount(4);

  const filenameSize = await measureOverflow(page.locator('.contributions li > span').first());
  expect(filenameSize.scrollWidth).toBeLessThanOrEqual(filenameSize.clientWidth + 1);

  const withDeliveries = await measureDocument(page);
  expect(withDeliveries.scrollWidth).toBeLessThanOrEqual(withDeliveries.clientWidth + 1);

  await page.locator('.event-extra summary').filter({ hasText: 'Shared gallery' }).click();
  await expect(page.locator('.photo-grid figure')).toHaveCount(6);

  const captionSize = await measureOverflow(page.locator('.photo-grid figcaption span').first());
  expect(captionSize.scrollWidth).toBeLessThanOrEqual(captionSize.clientWidth + 1);

  const withGallery = await measureDocument(page);
  expect(withGallery.scrollWidth).toBeLessThanOrEqual(withGallery.clientWidth + 1);
});

test('the guest footer wraps its brand clear of the tagline at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubGuestRoutes(page);

  await page.goto('/event/maya-theo');
  const brand = page.locator('.guest-shell footer .brand');
  const tagline = page.locator('.guest-shell footer p');
  await expect(brand).toBeVisible();
  await expect(tagline).toBeVisible();

  const separation = await measureSeparation(brand, tagline);
  expect(separation, 'footer brand clear of the tagline').toBeGreaterThanOrEqual(12);

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

test('the full-screen gallery stays contained with a reachable close target at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubGuestRoutes(page, { gallery: makeMedia(3) });

  await page.goto('/event/maya-theo/fullscreen');
  await expect(page.locator('.fullscreen figure')).toHaveCount(3);

  const captionSize = await measureOverflow(page.locator('.fullscreen figcaption').first());
  expect(captionSize.scrollWidth).toBeLessThanOrEqual(captionSize.clientWidth + 1);

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);

  const closeSize = await measureTarget(page.getByRole('link', { name: 'Close full-screen gallery' }));
  expect(closeSize.width).toBeGreaterThanOrEqual(44);
  expect(closeSize.height).toBeGreaterThanOrEqual(44);
});

test('paused guest main and fullscreen share the Gallery projection and stay contained at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const gallery = makeMedia(4, 'published');
  const contributions = makeMedia(2);
  await stubGuestRoutes(page, {
    event: {
      uploadsEnabled: false,
      phase: 'waiting',
      guestReadSurfaces: { available: true, reason: null },
    },
    gallery,
    contributions,
    messages: [{
      id: 'paused-responsive-note',
      guestName: 'Avery',
      body: 'The Guestbook remains part of the event while new uploads are paused.',
      moderationStatus: 'approved',
      createdAt: '2026-09-19T23:00:00Z',
    }],
  });

  await page.goto('/event/maya-theo');
  await expect(page.getByRole('heading', { name: 'New guest uploads are paused' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take a photo', exact: true })).toHaveCount(0);

  const guestbook = page.locator('details.guestbook');
  await guestbook.locator('summary').click();
  await expect(guestbook).toHaveAttribute('open', '');
  await expect(page.getByText('The Guestbook remains part of the event while new uploads are paused.'))
    .toBeVisible();

  const sharedGallery = page.locator('details.event-extra').filter({ hasText: 'Shared gallery' });
  await sharedGallery.locator('summary').click();
  await expect(page.locator('.photo-grid figure')).toHaveCount(gallery.length);
  const mainOrder = await page.locator('.photo-grid figcaption > span').allTextContents();

  const deliveries = page.locator('details.event-extra').filter({ hasText: 'My deliveries' });
  await deliveries.locator('summary').click();
  await expect(page.locator('.contributions li')).toHaveCount(contributions.length);

  const mainDocument = await measureDocument(page);
  expect(mainDocument.scrollWidth, 'paused guest main page at 320')
    .toBeLessThanOrEqual(mainDocument.clientWidth + 1);

  await sharedGallery.getByRole('link', { name: 'View full screen' }).click();
  await expect(page.getByRole('heading', { name: 'Shared gallery · Maya & Theo' })).toBeVisible();
  const fullscreenOrder = await page.locator('.fullscreen__grid figcaption').allTextContents();
  expect(fullscreenOrder).toEqual(mainOrder);
  await expect(page.locator('details.guestbook')).toHaveCount(0);
  await expect(page.locator('.contributions')).toHaveCount(0);
  await expect(page.getByText('My deliveries', { exact: true })).toHaveCount(0);

  const fullscreenCaption = await measureOverflow(page.locator('.fullscreen figcaption').first());
  expect(fullscreenCaption.scrollWidth).toBeLessThanOrEqual(fullscreenCaption.clientWidth + 1);
  const fullscreenDocument = await measureDocument(page);
  expect(fullscreenDocument.scrollWidth, 'paused guest fullscreen at 320')
    .toBeLessThanOrEqual(fullscreenDocument.clientWidth + 1);
  const close = await measureTarget(page.getByRole('link', { name: 'Close full-screen gallery' }));
  expect(close.width).toBeGreaterThanOrEqual(44);
  expect(close.height).toBeGreaterThanOrEqual(44);
});

test('guest media grids widen at the 761 px enhancement boundary', async ({ page }) => {
  await stubGuestRoutes(page, { gallery: makeMedia(6) });

  for (const width of [761, 768]) {
    await page.setViewportSize({ width, height: 900 });

    await page.goto('/event/maya-theo');
    await page.locator('.event-extra summary').filter({ hasText: 'Shared gallery' }).click();
    await expect(page.locator('.photo-grid figure')).toHaveCount(6);
    expect((await measureGridTracks(page.locator('.photo-grid'))).length).toBe(12);

    const gallerySize = await measureDocument(page);
    expect(gallerySize.scrollWidth).toBeLessThanOrEqual(gallerySize.clientWidth + 1);

    await page.goto('/event/maya-theo/fullscreen');
    await expect(page.locator('.fullscreen figure')).toHaveCount(6);
    expect((await measureGridTracks(page.locator('.fullscreen__grid'))).length).toBe(3);

    const fullscreenSize = await measureDocument(page);
    expect(fullscreenSize.scrollWidth).toBeLessThanOrEqual(fullscreenSize.clientWidth + 1);
  }
});

test('View full screen remains a 44 by 44 target across guest layout widths', async ({ page }) => {
  await stubGuestRoutes(page, { gallery: makeMedia(3) });

  for (const width of [320, 761, 1101]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/event/maya-theo');
    await page.locator('.event-extra summary').filter({ hasText: 'Shared gallery' }).click();

    const link = page.getByRole('link', { name: 'View full screen' });
    await expect(link).toBeVisible();
    const target = await measureTarget(link);
    expect(target.width, `View full screen width at ${width}`).toBeGreaterThanOrEqual(44);
    expect(target.height, `View full screen height at ${width}`).toBeGreaterThanOrEqual(44);

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

test('a 500-character welcome keeps both photo sources on the first fold at 320 by 568', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await stubGuestRoutes(page, {
    event: { welcomeMessage: LONG_WELCOME, theme: eventTheme('garden-party') },
  });

  await page.goto('/event/maya-theo');
  const camera = page.getByRole('button', { name: 'Take a photo', exact: true });
  const library = page.getByRole('button', { name: 'Choose recent photos', exact: true });
  await expect(camera).toBeVisible();

  for (const [label, action] of [['camera', camera], ['library', library]] as const) {
    const bounds = await measureFold(page, action);
    expect(bounds.bottom, `${label} bottom within the fold`).toBeLessThanOrEqual(bounds.fold);
  }

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);

  const toggle = page.getByRole('button', { name: 'Read full welcome' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(LONG_WELCOME);

  await toggle.click();
  const expanded = page.getByRole('button', { name: 'Show less' });
  await expect(expanded).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.photo-drop__hero')).toHaveClass(/photo-drop__hero--welcome-expanded/u);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(LONG_WELCOME);

  const expandedSize = await measureDocument(page);
  expect(expandedSize.scrollWidth).toBeLessThanOrEqual(expandedSize.clientWidth + 1);
});

test('phone landscape keeps the camera action in view at 844 by 390', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await stubGuestRoutes(page);

  await page.goto('/event/maya-theo');
  const camera = page.getByRole('button', { name: 'Take a photo', exact: true });
  await expect(camera).toBeVisible();

  const bounds = await measureFold(page, camera);
  expect(bounds.top, 'camera starts above the fold').toBeLessThan(bounds.fold);
  expect(bounds.visible, 'a full tap target is reachable without scrolling').toBeGreaterThanOrEqual(44);

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

test('a 500-character welcome keeps the camera action in view in phone landscape', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await stubGuestRoutes(page, { event: { welcomeMessage: LONG_WELCOME } });

  await page.goto('/event/maya-theo');
  const camera = page.getByRole('button', { name: 'Take a photo', exact: true });
  await expect(camera).toBeVisible();

  const bounds = await measureFold(page, camera);
  expect(bounds.top, 'camera starts above the fold').toBeLessThan(bounds.fold);
  expect(bounds.visible, 'a full tap target is reachable without scrolling').toBeGreaterThanOrEqual(44);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(LONG_WELCOME);
});

test('the long welcome keeps both photo sources reachable through the 500 to 567 px height band', async ({ page }) => {
  await stubGuestRoutes(page, { event: { welcomeMessage: LONG_WELCOME } });

  for (const height of [500, 520, 567]) {
    await page.setViewportSize({ width: 844, height });
    await page.goto('/event/maya-theo');

    const toggle = page.getByRole('button', { name: 'Read full welcome' });
    await expect(toggle, `welcome remains clamped at 844 by ${height}`).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(LONG_WELCOME);

    for (const [label, action] of [
      ['camera', page.getByRole('button', { name: 'Take a photo', exact: true })],
      ['library', page.getByRole('button', { name: 'Choose recent photos', exact: true })],
    ] as const) {
      const bounds = await measureFold(page, action);
      expect(bounds.top, `${label} starts above the fold at 844 by ${height}`).toBeLessThan(bounds.fold);
      expect(bounds.visible, `a full ${label} target is reachable at 844 by ${height}`).toBeGreaterThanOrEqual(44);
    }

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth, `document stays contained at 844 by ${height}`)
      .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

// A 1280 px laptop at the 200% zoom WCAG expects leaves a 640 by 450 layout viewport. The guest hero is
// the surface with the most to lose: 450 px of height is shorter than any phone this app supports.
test('the guest photo drop holds the 1280-at-200%-zoom layout at 640 by 450', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 450 });
  await stubGuestRoutes(page, {
    event: { welcomeMessage: LONG_WELCOME, theme: eventTheme('coastal-light') },
  });

  await page.goto('/event/maya-theo');
  const camera = page.getByRole('button', { name: 'Take a photo', exact: true });
  const library = page.getByRole('button', { name: 'Choose recent photos', exact: true });
  await expect(camera).toBeVisible();

  for (const [label, action] of [['camera', camera], ['library', library]] as const) {
    const bounds = await measureFold(page, action);
    expect(bounds.top, `${label} starts above the zoomed fold`).toBeLessThan(bounds.fold);
    expect(bounds.visible, `a full ${label} target is reachable without scrolling`).toBeGreaterThanOrEqual(44);
  }

  // The welcome still clamps rather than pushing the photo sources off a 450 px viewport.
  await expect(page.getByRole('button', { name: 'Read full welcome' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(LONG_WELCOME);

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

test('review status text stays within the caption band at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubGuestRoutes(page);

  await page.goto('/event/maya-theo');
  await page.getByLabel('Your name').fill('Taylor Morgan');
  await page.locator('input[data-photo-source="library"]').setInputFiles([KEEPER, REJECT]);
  await expect(page.getByText('2 photos selected')).toBeVisible();

  for (const locator of [
    page.locator('.selection-card__status strong'),
    page.locator('.selection-card__status span'),
    page.locator('.selection-card__status small'),
  ]) {
    const fontSize = await locator.first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(12);
    expect(fontSize).toBeLessThanOrEqual(14);
  }

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

test('the all-invalid review state stays contained at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubGuestRoutes(page);

  await page.goto('/event/maya-theo');
  await page.getByLabel('Your name').fill('Taylor Morgan');
  await page.locator('input[data-photo-source="library"]').setInputFiles([REJECT]);

  await expect(page.getByText('Remove or replace the photos that need attention.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Send/u })).toHaveCount(0);

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

test('the delivery receipt with a caveat stays contained at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubGuestRoutes(page);
  await stubUploadDelivery(page);

  await page.goto('/event/maya-theo');
  await page.getByLabel('Your name').fill('Taylor Morgan');
  await page.locator('input[data-photo-source="library"]').setInputFiles([KEEPER, REJECT]);
  await page.getByRole('button', { name: 'Send 1 photo' }).click();

  await expect(page.getByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
  await expect(page.getByText('1 photo could not be added.')).toBeVisible();

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

const MAX_GUESTBOOK_PROMPT = `${'احتفظوا بهذه الذكرى الجميلة من يومكم — '.repeat(8)}🌿`.slice(0, 160);
const MAX_GUESTBOOK_BODY = `${'في هذا اليوم رأينا المحبة في كل تفصيل صغير — '.repeat(18)}✨`.slice(0, 500);
const RTL_GUESTBOOK_ENTRY: GuestGuestbookItem = {
  id: 'note-rtl',
  source: 'guest_note',
  kind: 'message',
  mediaId: null,
  guestName: 'ليلى'.repeat(20),
  body: MAX_GUESTBOOK_BODY,
  createdAt: '2026-09-19T20:00:00Z',
  state: 'approved',
  moderationStatus: 'approved',
  visibility: 'shared',
  isOwn: false,
};

test('Guestbook contains maximum RTL and Unicode content at phone, desktop, and zoom-equivalent widths', async ({ page }) => {
  await stubGuestRoutes(page, {
    event: { guestbookPrompt: MAX_GUESTBOOK_PROMPT },
    guestbook: { shared: [RTL_GUESTBOOK_ENTRY] },
  });
  await page.goto('/event/maya-theo');

  for (const { width, height, label } of [
    { width: 320, height: 844, label: '320 phone and 400% zoom equivalent' },
    { width: 390, height: 844, label: '390 phone' },
    { width: 1280, height: 900, label: 'representative desktop' },
    { width: 640, height: 450, label: '200% zoom equivalent' },
  ]) {
    await page.setViewportSize({ width, height });
    const guestbook = page.locator('details.guestbook');
    if (!(await guestbook.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await guestbook.locator('summary').click();
    }
    await expect(page.getByText(MAX_GUESTBOOK_PROMPT)).toHaveAttribute('dir', 'auto');
    const entry = page.locator('.guestbook-entry');
    await expect(entry.locator('.guestbook-entry__body > p')).toHaveAttribute('dir', 'auto');
    await expect(entry.locator('.guestbook-entry__meta small')).toHaveAttribute('dir', 'auto');
    const body = await measureOverflow(entry.locator('.guestbook-entry__body > p'));
    expect(body.scrollWidth, `${label} body wraps`).toBeLessThanOrEqual(body.clientWidth + 1);
    for (const control of await guestbook.locator('button:visible, summary:visible').all()) {
      const target = await measureTarget(control);
      expect(target.width, `${label} control width`).toBeGreaterThanOrEqual(44);
      expect(target.height, `${label} control height`).toBeGreaterThanOrEqual(44);
    }
    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth, `${label} document width`)
      .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

test('keyboard-only guest contribution confirms and announces the server response', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubGuestRoutes(page);
  await page.goto('/event/maya-theo');
  const summary = page.locator('details.guestbook summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  const note = page.getByRole('textbox', { name: 'Your note for Maya & Theo' });
  await note.focus();
  await page.keyboard.type('A keyboard-written wish for the happy couple.');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Send note' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Confirm and send' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Safely sent to Maya & Theo.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your private entries' })).toBeVisible();
});

test('gallery-off keeps a published caption out of Shared while retaining the current author read-back', async ({ page }) => {
  const caption: GuestGuestbookItem = {
    id: 'caption-own',
    source: 'photo_caption',
    kind: 'caption',
    mediaId: 'media-caption-own',
    guestName: 'Avery',
    body: 'A private read-back while the shared gallery is off.',
    createdAt: '2026-09-19T21:00:00Z',
    state: 'published',
    moderationStatus: 'rejected',
    visibility: 'author_only',
    previewAvailable: true,
    isOwn: true,
  };
  await stubGuestRoutes(page, {
    event: { galleryVisible: false },
    guestbook: { ownUnshared: [caption] },
  });
  await page.goto('/event/maya-theo');
  await page.locator('details.guestbook summary').click();
  await expect(page.getByRole('heading', { name: 'Your private entries' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Shared guestbook' })
    .locator('..').locator('.guestbook-entry')).toHaveCount(0);
  await expect(page.getByText('A private read-back while the shared gallery is off.')).toBeVisible();
  await expect(page.getByText('Your entry')).toBeVisible();
});

/* iOS Safari zooms the viewport whenever a focused control computes under 16px and never zooms back
   out, so an undersized guest field leaves the respondent pinching the page straight before they can
   carry on. The global `input { font: inherit }` takes its size from whichever label wraps the
   field, which is how two of these three drifted under the floor while the third stayed correct.
   This walks every visible guest text field rather than the three known ones, so a new field that
   inherits a small label is caught here rather than on someone's phone. */
test('every guest text field clears the 16px iOS focus-zoom floor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const surface of ['photos', 'rsvp'] as const) {
    await stubGuestRoutes(page, surface === 'rsvp'
      ? {
        event: {
          uploadsEnabled: false,
          phase: 'rsvp-primary',
          rsvpState: 'open',
          rsvpAccess: 'editable',
          rsvpDeadlineAt: '2026-09-05T23:59:59.999Z',
          rsvpDeadlineDate: '2026-09-05',
        },
      }
      : {});
    await page.goto('/event/maya-theo');

    if (surface === 'photos') {
      await page.locator('details.guestbook summary').click();
      await page.getByRole('button', { name: 'Add your name' }).click();
    }

    const fields = page.locator('.guest-shell--drop input[type="text"], .guest-shell--drop input:not([type])');
    await expect(fields.first(), `${surface} renders at least one guest field`).toBeVisible();
    const count = await fields.count();
    for (let index = 0; index < count; index += 1) {
      const field = fields.nth(index);
      if (!(await field.isVisible())) continue;
      const size = await field.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
      const name = await field.evaluate((element) => element.getAttribute('aria-label')
        ?? element.closest('label')?.textContent?.trim().slice(0, 40)
        ?? element.className);
      expect(size, `${surface} field "${name}" font size`).toBeGreaterThanOrEqual(16);
    }
  }
});

/* `.notes-feed li` carries no colour of its own, so its rule falls back to `currentColor` — full
   page ink — the moment the list is mounted outside whatever ancestor supplies one. That is exactly
   what happened when the Guestbook replaced the Notes surface and left the colouring rule behind on
   a class nothing renders. The token is resolved through the browser rather than restated as a hex
   literal here, so this stays true for all four presets. */
test('the Guestbook draws its row rules in the event section border, not page ink', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubGuestRoutes(page, {
    event: { theme: eventTheme('garden-party') },
    guestbook: {
      shared: [{
        id: 'note-rule',
        source: 'guest_note',
        kind: 'message',
        mediaId: null,
        guestName: 'Ada',
        body: 'A shared note that gives the feed a row rule to measure.',
        createdAt: '2026-09-19T20:00:00Z',
        state: 'approved',
        moderationStatus: 'approved',
        visibility: 'shared',
        isOwn: false,
      } as GuestGuestbookItem],
    },
  });
  await page.goto('/event/maya-theo');
  await page.locator('details.guestbook summary').click();

  const measured = await page.locator('.guestbook-section .notes-feed li').first()
    .evaluate((element) => {
      const probe = document.createElement('span');
      element.append(probe);
      const read = (value: string) => {
        probe.style.color = value;
        return getComputedStyle(probe).color;
      };
      const sectionBorder = read('var(--event-section-border)');
      const pageText = read('var(--event-page-text)');
      probe.remove();
      return { border: getComputedStyle(element).borderTopColor, sectionBorder, pageText };
    });

  expect(measured.border).toBe(measured.sectionBorder);
  expect(measured.border).not.toBe(measured.pageText);
});

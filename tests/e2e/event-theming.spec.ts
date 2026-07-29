import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';

import type { EventThemePresetId, ResolvedEventTheme } from '../../shared/contracts';
import {
  PHOTOGRAPHIC_COVER,
  PURE_BLACK_COVER,
  PURE_WHITE_COVER,
} from './fixtures/cover-images';
import { EVENT_FIXTURE, eventTheme, stubGuestRoutes, stubManagerRoutes } from './fixtures/routes';
import { LONG_FILENAME, LONG_WELCOME, TEST_NOTE, makeMedia } from './fixtures/ui-data';
import { measureDocument, measureTarget } from './helpers/geometry';
import {
  makeTextTransparent,
  minimumWhiteContrast,
  minimumWhiteContrastUnderText,
} from './helpers/theme-contrast';

type MatrixState =
  | 'no-cover entry'
  | 'cover entry'
  | '500-character welcome'
  | 'review with long filenames'
  | 'active progress and retry failure'
  | 'terminal receipt'
  | 'gallery deliveries and Notes'
  | 'full-screen long caption';

const VIEWPORTS = [
  { name: '320x568', width: 320, height: 568 },
  { name: '390x844', width: 390, height: 844 },
  { name: '1280x900', width: 1280, height: 900 },
] as const;

const MATRIX: ReadonlyArray<{
  state: MatrixState;
  presets: readonly [EventThemePresetId, EventThemePresetId, EventThemePresetId];
}> = [
  { state: 'no-cover entry', presets: ['candidary-default', 'coastal-light', 'garden-party'] },
  { state: 'cover entry', presets: ['midnight-film', 'candidary-default', 'coastal-light'] },
  { state: '500-character welcome', presets: ['coastal-light', 'candidary-default', 'garden-party'] },
  { state: 'review with long filenames', presets: ['candidary-default', 'coastal-light', 'midnight-film'] },
  { state: 'active progress and retry failure', presets: ['coastal-light', 'candidary-default', 'garden-party'] },
  { state: 'terminal receipt', presets: ['candidary-default', 'coastal-light', 'midnight-film'] },
  { state: 'gallery deliveries and Notes', presets: ['coastal-light', 'candidary-default', 'garden-party'] },
  { state: 'full-screen long caption', presets: ['candidary-default', 'coastal-light', 'midnight-film'] },
];

const IMAGE = {
  name: LONG_FILENAME.replace(/\.HEIC$/u, '.png'),
  mimeType: 'image/png',
  buffer: PHOTOGRAPHIC_COVER,
};

function onlyOnce(testInfo: TestInfo) {
  test.skip(testInfo.project.name === 'mobile', 'Viewport-pinned behavioral evidence runs once.');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function expectContained(page: Page, label: string) {
  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth, `${label} document width`)
    .toBeLessThanOrEqual(documentSize.clientWidth + 1);
}

async function expectTargets(targets: readonly Locator[], label: string) {
  for (const target of targets) {
    await expect(target).toBeVisible();
    const size = await measureTarget(target);
    expect(size.width, `${label} target width`).toBeGreaterThanOrEqual(44);
    expect(size.height, `${label} target height`).toBeGreaterThanOrEqual(44);
  }
}

async function expectTheme(scope: Locator, theme: ResolvedEventTheme) {
  await expect(scope).toHaveCSS('--event-page', theme.tokens.page);
  await expect(scope).toHaveCSS('--event-primary', theme.tokens.primary);
  await expect(scope).toHaveCSS('--event-accent', theme.tokens.accent);
  await expect(scope).toHaveCSS('--event-focus', theme.tokens.focus);
}

async function stubSuccessfulUpload(page: Page) {
  const base = `**/api/event/${EVENT_FIXTURE.slug}`;
  await page.route(`${base}/uploads/batch`, async (route) => {
    const payload = route.request().postDataJSON() as {
      files: Array<{ idempotencyKey: string; mimeType: string }>;
    };
    const origin = new URL(page.url()).origin;
    await route.fulfill({
      status: 201,
      json: {
        data: {
          items: payload.files.map((file) => ({
            idempotencyKey: file.idempotencyKey,
            status: 'accepted',
            media: { id: `media-${file.idempotencyKey}`, mimeType: file.mimeType },
            uploadUrl: `${origin}/direct-upload/${file.idempotencyKey}`,
          })),
        },
        requestId: 'request-a',
      },
    });
  });
  await page.route('**/direct-upload/*', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route(`${base}/uploads/*/finalize`, (route) => route.fulfill({
    json: { data: { media: { uploadState: 'stored' } }, requestId: 'request-a' },
  }));
}

async function renderMatrixState(page: Page, state: MatrixState, theme: ResolvedEventTheme) {
  const baseOptions = { event: { theme } };
  if (state === 'no-cover entry') {
    await stubGuestRoutes(page, baseOptions);
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await page.getByRole('button', { name: 'Take a photo', exact: true }).click();
    await expect(page.getByText('Enter your name before adding photos.')).toBeVisible();
    await expect(page.getByLabel('Your name')).toBeFocused();
    await page.getByLabel('Your name').fill('Taylor Morgan');
    await expectTargets([
      page.getByRole('button', { name: 'Take a photo', exact: true }),
      page.getByRole('button', { name: 'Choose recent photos', exact: true }),
    ], state);
  } else if (state === 'cover entry') {
    await stubGuestRoutes(page, {
      ...baseOptions,
      event: { ...baseOptions.event, coverObjectKey: 'events/event-a/cover.png' },
    });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await expect(page.locator('.photo-drop__hero')).toHaveClass(/photo-drop__hero--cover/u);
    await expectTargets([
      page.getByRole('button', { name: 'Take a photo', exact: true }),
      page.getByRole('button', { name: 'Choose recent photos', exact: true }),
    ], state);
  } else if (state === '500-character welcome') {
    await stubGuestRoutes(page, {
      ...baseOptions,
      event: { ...baseOptions.event, welcomeMessage: LONG_WELCOME },
    });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    const toggle = page.getByRole('button', { name: 'Read full welcome' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(LONG_WELCOME);
  } else if (state === 'review with long filenames') {
    await stubGuestRoutes(page, baseOptions);
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await page.getByLabel('Your name').fill('Taylor Morgan');
    await page.locator('input[data-photo-source="library"]').setInputFiles(IMAGE);
    await expect(page.getByText(IMAGE.name)).toBeVisible();
    await expect(page.locator('.photo-drop--review')).toBeVisible();
  } else if (state === 'active progress and retry failure') {
    const reservation = deferred();
    await stubGuestRoutes(page, baseOptions);
    await page.route(`**/api/event/${EVENT_FIXTURE.slug}/uploads/batch`, async (route) => {
      await reservation.promise;
      const payload = route.request().postDataJSON() as { files: Array<{ idempotencyKey: string }> };
      await route.fulfill({
        status: 201,
        json: {
          data: {
            items: payload.files.map(({ idempotencyKey }) => ({
              idempotencyKey,
              status: 'rejected',
              error: { message: 'Reception dropped out. Try this photo again.' },
            })),
          },
          requestId: 'request-a',
        },
      });
    });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await page.getByLabel('Your name').fill('Taylor Morgan');
    await page.locator('input[data-photo-source="library"]').setInputFiles(IMAGE);
    await page.getByRole('button', { name: 'Send 1 photo' }).click();
    await expect(page.getByText('Getting ready')).toBeVisible();
    reservation.resolve();
    await expect(page.getByText('Needs attention', { exact: true })).toBeVisible();
    const retry = page.getByRole('button', { name: 'Retry 1 photo' });
    await expectTargets([retry], state);
  } else if (state === 'terminal receipt') {
    await stubGuestRoutes(page, baseOptions);
    await stubSuccessfulUpload(page);
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await page.getByLabel('Your name').fill('Taylor Morgan');
    await page.locator('input[data-photo-source="library"]').setInputFiles(IMAGE);
    await page.getByRole('button', { name: 'Send 1 photo' }).click();
    await expect(page.getByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
  } else if (state === 'gallery deliveries and Notes') {
    await stubGuestRoutes(page, {
      ...baseOptions,
      gallery: makeMedia(3),
      contributions: makeMedia(2),
      messages: [TEST_NOTE],
    });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    for (const summary of ['Shared gallery', 'My deliveries', 'Leave a note']) {
      await page.locator('.event-extra summary').filter({ hasText: summary }).click();
    }
    await expect(page.locator('.photo-grid figure')).toHaveCount(3);
    await expect(page.locator('.contributions li')).toHaveCount(2);
    await expect(page.locator('.notes-feed li')).toHaveCount(1);
  } else {
    await stubGuestRoutes(page, { ...baseOptions, gallery: makeMedia(3) });
    await page.goto(`/event/${EVENT_FIXTURE.slug}/fullscreen`);
    await expect(page.locator('.fullscreen figure')).toHaveCount(3);
    await expect(page.locator('.fullscreen figcaption').first()).toHaveText(LONG_FILENAME);
    await expectTargets([page.getByRole('link', { name: 'Close full-screen gallery' })], state);
  }

  const scope = state === 'full-screen long caption'
    ? page.locator('.fullscreen')
    : page.locator('.guest-shell--drop');
  await expectTheme(scope, theme);
}

test('guest event fixture omits every manager-only event field', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await stubGuestRoutes(page);
  const eventResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/event/${EVENT_FIXTURE.slug}`);
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  const payload = await (await eventResponse).json() as {
    data: { event: Record<string, unknown> };
  };
  const managerOnlyFields = [
    'reservedMediaCount',
    'storedMediaCount',
    'reservedBytes',
    'storedBytes',
    'guestAccessExpiresAt',
    'managementAccessExpiresAt',
    'purgeAfter',
    'createdAt',
    'deletedAt',
  ];
  expect(managerOnlyFields.filter((field) => field in payload.data.event)).toEqual([]);
});

test.describe('responsive themed guest state matrix', () => {
  for (const { state, presets } of MATRIX) {
    for (const [index, viewport] of VIEWPORTS.entries()) {
      const preset = presets[index]!;
      test(`${state} uses ${preset} at ${viewport.name}`, async ({ page }, testInfo) => {
        onlyOnce(testInfo);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await renderMatrixState(page, state, eventTheme(preset));
        await expectContained(page, `${state} ${viewport.name}`);
      });
    }
  }
});

test('remembered-name, validation, and keyboard operation retain themed 44 px actions', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('candidary_guest_name', 'Avery Stone'));
  const theme = eventTheme('garden-party');
  await stubGuestRoutes(page, { event: { theme } });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);

  await expect(page.getByText('Sending as Avery Stone')).toBeVisible();
  await page.getByRole('button', { name: 'Edit name' }).click();
  const name = page.getByLabel('Your name');
  await name.fill('');
  await name.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Enter your name before adding photos.')).toBeVisible();
  await expect(name).toBeFocused();

  await name.fill('Avery Stone');
  await page.keyboard.press('Tab');
  const camera = page.getByRole('button', { name: 'Take a photo', exact: true });
  await expect(camera).toBeFocused();
  await expectTargets([
    camera,
    page.getByRole('button', { name: 'Choose recent photos', exact: true }),
  ], 'remembered guest');
  await expectTheme(page.locator('.guest-shell--drop'), theme);
});

test('reserving, queued, uploading, finalizing, cancel, failure, and retry all retain theme paint', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  const reservation = deferred();
  const firstUploads = deferred();
  const finalizations = deferred();
  let cycle = 1;

  const theme = eventTheme('coastal-light');
  await stubGuestRoutes(page, { event: { theme } });
  await page.route(`**/api/event/${EVENT_FIXTURE.slug}/uploads/batch`, async (route) => {
    if (cycle === 1) await reservation.promise;
    const payload = route.request().postDataJSON() as {
      files: Array<{ idempotencyKey: string; mimeType: string }>;
    };
    const origin = new URL(page.url()).origin;
    await route.fulfill({
      status: 201,
      json: {
        data: {
          items: payload.files.map((file) => ({
            idempotencyKey: file.idempotencyKey,
            status: 'accepted',
            media: { id: `media-${file.idempotencyKey}`, mimeType: file.mimeType },
            uploadUrl: `${origin}/direct-upload/${file.idempotencyKey}`,
          })),
        },
        requestId: 'request-a',
      },
    });
  });
  await page.route('**/direct-upload/*', async (route) => {
    const requestCycle = cycle;
    if (requestCycle === 1) await firstUploads.promise;
    await route.fulfill({ status: 200, body: '' }).catch(() => {});
  });
  await page.route(`**/api/event/${EVENT_FIXTURE.slug}/uploads/*/finalize`, async (route) => {
    await finalizations.promise;
    await route.fulfill({
      json: { data: { media: { uploadState: 'stored' } }, requestId: 'request-a' },
    }).catch(() => {});
  });

  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await page.getByLabel('Your name').fill('Taylor Morgan');
  await page.locator('input[data-photo-source="library"]').setInputFiles([
    IMAGE,
    { ...IMAGE, name: 'second.png' },
    { ...IMAGE, name: 'third.png' },
  ]);
  await page.getByRole('button', { name: 'Send 3 photos' }).click();
  await expect(page.getByText('Getting ready').first()).toBeVisible();
  reservation.resolve();
  await expect(page.getByText('Sending ·', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Waiting to send')).toBeVisible();
  const cancel = page.getByRole('button', { name: 'Cancel sending' });
  await expectTargets([cancel], 'cancel');
  await expect(cancel).toHaveCSS('color', 'rgb(12, 99, 112)');
  await cancel.click();
  await expect(page.getByText('Needs attention').first()).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry 3 photos' });
  await page.mouse.move(10_000, 10_000);
  await expect(retry).toHaveCSS('background-color', 'rgb(12, 99, 112)');
  firstUploads.resolve();

  cycle = 2;
  await retry.click();
  await expect(page.getByText('Confirming delivery').first()).toBeVisible();
  finalizations.resolve();
  await expect(page.getByRole('heading', { name: 'Your 3 photos were sent.' })).toBeVisible();
  await expectTheme(page.locator('.guest-shell--drop'), theme);
  await expectContained(page, 'complete upload lifecycle');
});

test('manager appearance PUT carries the canonical config and adopts the normalized fixture response', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 390, height: 1200 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Event appearance' })).toBeVisible();

  await page.getByRole('radio', { name: /Coastal Light/u }).check();
  const themeRequest = page.waitForRequest(
    (request) => request.url().endsWith(`/api/manage/events/${EVENT_FIXTURE.id}/theme`),
  );
  await page.getByRole('button', { name: 'Save appearance' }).click();
  const request = await themeRequest;
  expect(request.method()).toBe('PUT');
  expect(request.postDataJSON()).toEqual({
    version: 1,
    presetId: 'coastal-light',
    overrides: {},
  });
  await expect(page.locator('.event-appearance-editor__status')).toHaveText('Saved');
  await expectTheme(page.locator('.event-appearance-preview'), eventTheme('coastal-light'));
});

test('Notes placeholder uses the approved themed muted text role', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await stubGuestRoutes(page, { event: { theme: eventTheme('candidary-default') } });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await page.locator('.event-extra summary').filter({ hasText: 'Leave a note' }).click();
  const placeholderColor = await page.getByRole('textbox', { name: 'Note for Maya & Theo' }).evaluate(
    (element) => getComputedStyle(element, '::placeholder').color,
  );
  expect(placeholderColor).toBe('rgb(119, 106, 112)');
});

for (const presetId of ['candidary-default', 'garden-party', 'midnight-film', 'coastal-light'] as const) {
  test(`${presetId} no-cover gradient clears 4.5:1 at all three exact hero geometries`, async ({ page }, testInfo) => {
    onlyOnce(testInfo);
    const cases = [
      { viewport: { width: 390, height: 844 }, forcedHeight: null, expected: [390, 205] },
      { viewport: { width: 390, height: 844 }, forcedHeight: 420, expected: [390, 420] },
      { viewport: { width: 1280, height: 900 }, forcedHeight: null, expected: [620, 265] },
    ] as const;

    for (const geometry of cases) {
      await page.setViewportSize(geometry.viewport);
      await stubGuestRoutes(page, { event: { theme: eventTheme(presetId) } });
      await page.goto(`/event/${EVENT_FIXTURE.slug}`);
      const hero = page.locator('.photo-drop__hero');
      if (geometry.forcedHeight) {
        await hero.evaluate((element, height) => {
          const heroElement = element as HTMLElement;
          heroElement.style.height = `${height}px`;
          heroElement.style.minHeight = `${height}px`;
        }, geometry.forcedHeight);
      }
      await makeTextTransparent(hero);
      const contrast = await minimumWhiteContrast(page, hero, { visiblePixelsOnly: true });
      expect([contrast.width, contrast.height], `${presetId} hero box`).toEqual(geometry.expected);
      expect(contrast.sampledPixels, `${presetId} visible hero pixels`).toBeGreaterThan(0);
      if (geometry.expected[0] === 620) {
        expect(contrast.sampledPixels, `${presetId} clipped desktop corners`)
          .toBeLessThan(geometry.expected[0] * geometry.expected[1]);
      }
      expect(contrast.minimum, `${presetId} ${geometry.expected.join('x')} minimum contrast`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  test(`${presetId} cover scrim clears 4.5:1 over white, black, and photographic pixels`, async ({ page }, testInfo) => {
    onlyOnce(testInfo);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [name, cover] of [
      ['pure white', PURE_WHITE_COVER],
      ['pure black', PURE_BLACK_COVER],
      ['photographic', PHOTOGRAPHIC_COVER],
    ] as const) {
      await stubGuestRoutes(page, {
        event: {
          theme: eventTheme(presetId),
          coverObjectKey: `events/event-a/${name.replace(' ', '-')}.png`,
        },
        cover,
      });
      await page.goto(`/event/${EVENT_FIXTURE.slug}`);
      const hero = page.locator('.photo-drop__hero--cover');
      const result = await minimumWhiteContrastUnderText(page, hero, hero.locator('.photo-drop__hero-copy'));
      expect(result.rectangles.length, `${presetId} ${name} rendered text bounds`).toBeGreaterThan(0);
      expect(result.minimum, `${presetId} ${name} cover-text contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';

import type { EventThemePresetId, ResolvedEventTheme } from '../../shared/contracts';
import {
  PHOTOGRAPHIC_COVER,
  PURE_BLACK_COVER,
  PURE_WHITE_COVER,
} from './fixtures/cover-images';
import {
  EVENT_FIXTURE,
  RSVP_HOUSEHOLD_FIXTURE,
  eventTheme,
  stubGuestRoutes,
  stubManagerRoutes,
} from './fixtures/routes';
import {
  LONG_FILENAME,
  LONG_WELCOME,
  NATURAL_420_WELCOME,
  TEST_NOTE,
  makeMedia,
} from './fixtures/ui-data';
import { measureContrast, measureDocument, measureTarget } from './helpers/geometry';
import { settleRendering } from './helpers/rendering';
import {
  makeTextTransparent,
  minimumWhiteContrast,
  minimumWhiteContrastUnderText,
  visiblePixelMask,
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

// The RSVP lifecycle is a themed guest surface like every other one, so each preset
// has to carry it from lookup through refusal to receipt without losing paint,
// target size, or the 4.5:1 floor.
const RSVP_PRIMARY_EVENT = {
  uploadsEnabled: false,
  phase: 'rsvp-primary' as const,
  rsvpState: 'open' as const,
  rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
  rsvpDeadlineDate: '2026-09-05',
};

for (const presetId of ['candidary-default', 'garden-party', 'midnight-film', 'coastal-light'] as const) {
  test(`${presetId} carries lookup, household, refusal, and receipt above the contrast floor`, async ({ page }, testInfo) => {
    onlyOnce(testInfo);
    await page.setViewportSize({ width: 390, height: 844 });
    const theme = eventTheme(presetId);
    await stubGuestRoutes(page, {
      event: { theme, ...RSVP_PRIMARY_EVENT },
      household: RSVP_HOUSEHOLD_FIXTURE,
      rsvpSession: false,
    });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);

    const shell = page.locator('.guest-shell--drop');
    await expectTheme(shell, theme);
    for (const selector of ['.rsvp-identity h1', '.rsvp-deadline', '.rsvp-field label', '.rsvp-privacy']) {
      expect(await measureContrast(page.locator(selector).first()), `${presetId} lookup ${selector}`)
        .toBeGreaterThanOrEqual(4.5);
    }
    const find = page.getByRole('button', { name: 'Find my invitation' });
    await expectTargets([find], `${presetId} lookup`);
    expect(await measureContrast(find), `${presetId} lookup action`).toBeGreaterThanOrEqual(4.5);
    await expectContained(page, `${presetId} RSVP lookup`);

    await page.getByLabel('Full name').fill('Taylor Morgan');
    await find.click();
    await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();
    await expectTheme(shell, theme);
    const attendance = page.locator('.rsvp-attendance label');
    await expectTargets([attendance.first()], `${presetId} attendance`);
    for (const selector of ['.rsvp-person legend', '.rsvp-counts', '.rsvp-attendance span']) {
      expect(await measureContrast(page.locator(selector).first()), `${presetId} household ${selector}`)
        .toBeGreaterThanOrEqual(4.5);
    }

    // A refusal has to read as a refusal even where the theme is darkest.
    await page.getByRole('button', { name: 'Submit RSVP' }).click();
    const error = page.locator('.rsvp-error').first();
    await expect(error).toBeVisible();
    expect(await measureContrast(error), `${presetId} refusal copy`).toBeGreaterThanOrEqual(4.5);

    // Chosen attendance is carried by a thicker border as well as colour.
    const unchosen = await attendance.first().evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).borderTopWidth));
    await page.getByRole('group', { name: RSVP_HOUSEHOLD_FIXTURE.invitees[0]!.displayName!, exact: true })
      .getByRole('radio', { name: 'Attending', exact: true }).check();
    const chosen = await attendance.first().evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).borderTopWidth));
    expect(chosen, `${presetId} selection is not colour alone`).toBeGreaterThan(unchosen);

    await page.getByRole('group', { name: RSVP_HOUSEHOLD_FIXTURE.invitees[1]!.displayName!, exact: true })
      .getByRole('radio', { name: 'Not attending', exact: true }).check();
    await page.getByRole('group', { name: 'Plus one 1', exact: true })
      .getByRole('radio', { name: 'Not attending', exact: true }).check();
    await page.getByRole('button', { name: 'Submit RSVP' }).click();

    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    await expectTheme(shell, theme);
    for (const selector of ['.rsvp-receipt h1', '.rsvp-receipt__roster span', '.rsvp-response', '.rsvp-receipt__deadline']) {
      expect(await measureContrast(page.locator(selector).first()), `${presetId} receipt ${selector}`)
        .toBeGreaterThanOrEqual(4.5);
    }
    await expectContained(page, `${presetId} RSVP receipt`);
  });
}

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

test('manager appearance autosaves the canonical config and adopts the normalized fixture response', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 390, height: 1200 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Event appearance' })).toBeVisible();

  const themeRequest = page.waitForRequest(
    (request) => request.url().endsWith(`/api/manage/events/${EVENT_FIXTURE.id}/theme`),
  );
  await page.getByRole('radio', { name: /Coastal Light/u }).check();
  const request = await themeRequest;
  expect(request.method()).toBe('PUT');
  expect(request.postDataJSON()).toEqual({
    version: 1,
    presetId: 'coastal-light',
    overrides: {},
  });
  await expect(page.locator('.event-appearance-editor__status .autosave-status__chip')).toHaveText('Saved');
  await expectTheme(page.locator('.event-appearance-preview'), eventTheme('coastal-light'));
});

test('manager Settings saves without a Save button and stays contained at 320 and 390', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await stubManagerRoutes(page, { mediaPages: { first: { media: [], nextCursor: null } } });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Event appearance' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save appearance' })).toHaveCount(0);

  const settingsRequest = page.waitForRequest(
    (request) => request.url().endsWith(`/api/manage/events/${EVENT_FIXTURE.id}/settings`),
  );
  const scrolledTo = await page.evaluate(() => {
    window.scrollTo({ top: 400, behavior: 'instant' });
    return window.scrollY;
  });
  await page.getByLabel('Show the optional shared gallery').click();
  expect((await settingsRequest).method()).toBe('PATCH');
  // Two live regions, each naming its own domain.
  await expect(page.getByText('Event settings saved')).toBeAttached();
  await expect(page.getByText('Event appearance saved')).toBeAttached();
  // Status text arriving must not shift the page under the host's hands.
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolledTo);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expectContained(page, `manager settings autosave at ${width}`);
  }
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
  expect(placeholderColor).toBe('rgb(119, 110, 106)');
});

test('visible-pixel masking keeps straight edges and excludes rounded top corners', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setContent(`
    <div style="width: 20px; height: 20px; overflow: hidden; border-radius: 6px;">
      <div data-mask-target style="width: 20px; height: 20px;"></div>
    </div>
  `);
  const width = 20;
  const height = 20;
  const mask = await visiblePixelMask(page.locator('[data-mask-target]'), width, height);
  const included = (x: number, y: number) => mask[y * width + x] === 1;
  expect({
    topCenter: included(10, 0),
    rightCenter: included(19, 10),
    bottomCenter: included(10, 19),
    leftCenter: included(0, 10),
    topLeft: included(0, 0),
    topRight: included(19, 0),
  }).toEqual({
    topCenter: true,
    rightCenter: true,
    bottomCenter: true,
    leftCenter: true,
    topLeft: false,
    topRight: false,
  });
});

for (const presetId of ['candidary-default', 'garden-party', 'midnight-film', 'coastal-light'] as const) {
  test(`${presetId} no-cover gradient clears 4.5:1 at all three exact hero geometries`, async ({ page }, testInfo) => {
    // Three exact screenshot/mask passes can exceed the default timeout under the full parallel matrix.
    test.slow();
    onlyOnce(testInfo);
    const cases = [
      { viewport: { width: 390, height: 844 }, welcomeMessage: null, expanded: false, expected: [390, 205] },
      {
        viewport: { width: 390, height: 844 },
        welcomeMessage: NATURAL_420_WELCOME,
        expanded: true,
        expected: [390, 420],
      },
      { viewport: { width: 1280, height: 900 }, welcomeMessage: null, expanded: false, expected: [620, 265] },
    ] as const;

    for (const geometry of cases) {
      await page.setViewportSize(geometry.viewport);
      await stubGuestRoutes(page, {
        event: {
          theme: eventTheme(presetId),
          ...(geometry.welcomeMessage ? { welcomeMessage: geometry.welcomeMessage } : {}),
        },
      });
      await page.goto(`/event/${EVENT_FIXTURE.slug}`);
      const hero = page.locator('.photo-drop__hero');
      if (geometry.expanded) {
        expect(EVENT_FIXTURE.name.length).toBeLessThanOrEqual(80);
        expect(geometry.welcomeMessage).toHaveLength(182);
        expect(geometry.welcomeMessage.length).toBeLessThanOrEqual(500);
        await page.getByRole('button', { name: 'Read full welcome' }).click();
        await expect(page.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
        await expect(hero).toHaveClass(/photo-drop__hero--welcome-expanded/u);
        await expectContained(page, `${presetId} expanded 390x420 hero`);
      }
      await settleRendering(page);
      const heroBox = await hero.boundingBox();
      expect(heroBox, `${presetId} hero bounding box`).not.toBeNull();
      expect([heroBox!.width, heroBox!.height], `${presetId} natural hero box`).toEqual(geometry.expected);
      await makeTextTransparent(hero);
      const contrast = await minimumWhiteContrast(page, hero, { visiblePixelsOnly: true });
      expect([contrast.width, contrast.height], `${presetId} hero box`).toEqual(geometry.expected);
      expect(contrast.sampledPixels, `${presetId} visible hero pixels`).toBeGreaterThan(0);
      if (geometry.expected[0] === 620) {
        expect(contrast.maskEvidence, `${presetId} desktop clip boundary evidence`).toEqual({
          topCenter: true,
          rightCenter: true,
          bottomCenter: true,
          leftCenter: true,
          topLeft: false,
          topRight: false,
        });
        expect(contrast.sampledPixels, `${presetId} clipped desktop corners`)
          .toBeLessThan(contrast.totalPixels);
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

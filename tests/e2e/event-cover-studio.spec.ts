import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

import type { EventView, GuestEventView } from '../../shared/contracts';
import {
  LANDSCAPE_CENTERED_LIGHT_COVER,
  PORTRAIT_EDGE_DARK_COVER,
} from './fixtures/cover-images';
import {
  EVENT_FIXTURE,
  GUEST_EVENT_FIXTURE,
  type CoverFixtureAudit,
  stubGuestRoutes,
  stubManagerRoutes,
} from './fixtures/routes';
import {
  measureDocument,
  measureFold,
  measureSeparation,
  measureTarget,
  measureViewportEscapes,
} from './helpers/geometry';
import { settleRendering } from './helpers/rendering';

const UPLOAD = {
  name: 'portrait-edge-dark.png',
  mimeType: 'image/png',
  buffer: PORTRAIT_EDGE_DARK_COVER,
};

function desktopOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name === 'mobile', 'Viewport-pinned browser evidence runs once.');
}

async function openManagerStudio(
  page: Page,
  options: Parameters<typeof stubManagerRoutes>[1] = {
    mediaPages: { first: { media: [], nextCursor: null } },
  },
): Promise<CoverFixtureAudit> {
  const audit = await stubManagerRoutes(page, options);
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Event appearance editor' })).toBeVisible();
  const invoker = page.getByRole('button', { name: 'Change cover' });
  await invoker.click();
  await expect(page.getByRole('dialog', { name: 'Cover Studio' })).toBeVisible();
  return audit;
}

async function choosePreset(page: Page, name = 'Warm Linen') {
  await page.getByRole('radio', { name }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a style' })).toBeFocused();
}

async function finishPreset(page: Page, style = 'Film') {
  await page.getByRole('radio', { name: new RegExp(`^${style}`, 'u') }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Save this cover' })).toBeFocused();
  await page.getByRole('button', { name: 'Done' }).click();
}

function records(audit: CoverFixtureAudit, kind: CoverFixtureAudit['records'][number]['kind']) {
  return audit.records.filter((record) => record.kind === kind);
}

const UPLOAD_COVER: EventView['cover'] = {
  ...EVENT_FIXTURE.cover,
  config: {
    version: 1,
    source: { kind: 'upload' },
    focus: { mode: 'manual', x: 0.2, y: 0.8, zoom: 1.25 },
    effect: 'soft',
  },
  revision: 7,
  hasCover: true,
};

async function setDocumentVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: next });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('Event Appearance places the captioned guest canvas before theme and color controls', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const editor = page.getByRole('region', { name: 'Event appearance editor' });
  const figure = editor.locator('figure.event-appearance-canvas');
  await expect(figure).toHaveCount(1);
  await expect(figure.locator(':scope > figcaption').first()).toHaveText('What guests see');
  await expect(editor.getByText(
    'Choose the colors and shape guests see. Theme and color changes save as you make them. Cover changes begin after you choose Done, and the current cover stays live until the new one is ready.',
    { exact: true },
  )).toBeVisible();
  await expect(editor.getByText('Cover changes apply immediately', { exact: false })).toHaveCount(0);

  for (const control of [
    editor.getByRole('group', { name: 'Event appearance' }),
    editor.getByRole('textbox', { name: 'Primary color', exact: true }),
    editor.getByRole('textbox', { name: 'Accent color', exact: true }),
  ]) {
    const target = await control.elementHandle();
    expect(target).not.toBeNull();
    expect(await figure.evaluate((canvas, target) => (
      canvas.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING
    ) !== 0, target!)).toBe(true);
  }

  const guest = figure.locator('.event-appearance-canvas__guest');
  await expect(guest).not.toHaveAttribute('role', 'img');
  await expect(guest.getByRole('button', { name: 'Change cover' })).toHaveCount(0);
  await expect(figure.getByRole('button', { name: 'Change cover' })).toBeVisible();
});

test('preset publication consumes its applied event without a redundant read or duplicate operation', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page);

  await choosePreset(page);
  await finishPreset(page);

  await expect(page.getByRole('dialog', { name: 'Cover Studio' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change cover' })).toBeFocused();
  const applied = page.locator('.cover-preparation--success');
  await expect(applied).toBeVisible();
  expect(await applied.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      borderColor: style.borderColor,
    };
  })).toEqual({
    backgroundColor: 'rgb(232, 236, 216)',
    color: 'rgb(78, 91, 40)',
    borderColor: 'rgb(104, 118, 61)',
  });
  const publications = records(audit, 'publication');
  expect(publications).toHaveLength(1);
  expect(publications[0]?.responseStatus).toBe(200);
  expect(publications[0]?.responseHeaders.location).toMatch(/\/cover\/publications\//u);
  expect(publications[0]?.requestBody).toMatchObject({
    expectedRevision: 0,
    source: { kind: 'preset', presetId: 'warm-linen' },
    effect: 'film',
  });
  const operationId = (publications[0]?.requestBody as { operationId: string }).operationId;
  expect(operationId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(records(audit, 'status')).toHaveLength(0);
  expect(records(audit, 'event-refresh')).toHaveLength(1);
  expect(await page.evaluate(() => sessionStorage.getItem('candidary.cover.operation.event-a')))
    .toBeNull();
});

test('Compose uses one real canvas, promotes the first 3px drag to manual framing, and requests no local transforms', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page);

  await page.getByLabel('Choose photo').setInputFiles(UPLOAD);
  await expect(page.getByRole('radio', { name: 'Upload a photo' })).toBeChecked();
  await page.getByRole('button', { name: 'Continue' }).click();
  const studio = page.getByRole('dialog', { name: 'Cover Studio' });
  await expect(studio.getByRole('heading', { name: 'Position the photo' })).toBeFocused();
  await expect(studio.locator('.event-appearance-canvas')).toHaveCount(1);
  await expect(studio.locator('.cover-composer__surface')).toHaveCount(0);
  await expect(studio.locator('.cover-composer img')).toHaveCount(0);
  await expect(studio.getByText('Automatic framing', { exact: true })).toBeVisible();
  await expect(studio.getByText(
    'Drag the preview to reposition it, or choose Adjust framing for precise controls.',
    { exact: true },
  )).toBeVisible();
  await expect(studio.getByRole('slider')).toHaveCount(0);

  const transformCount = records(audit, 'transform').length;
  expect(transformCount).toBe(3);
  const guest = studio.locator('.event-appearance-canvas__guest');
  const image = studio.locator(
    '.event-appearance-canvas__local-cover .responsive-cover__image',
  );
  const box = await guest.boundingBox();
  expect(box).not.toBeNull();
  const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  const position = () => image.evaluate((element) => (
    (element as HTMLImageElement).style.objectPosition
  ));
  expect(await position()).toBe('50% 50%');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 2, start.y - 1);
  expect(await position()).toBe('50% 50%');
  await expect(studio.getByText('Automatic framing', { exact: true })).toBeVisible();
  await expect(studio.getByRole('slider')).toHaveCount(0);

  await page.mouse.move(start.x - 20, start.y);
  const expectedX = 0.5 + 20 / box!.width;
  await expect.poll(async () => Number.parseFloat((await position()).split('%')[0]!))
    .toBeCloseTo(expectedX * 100, 4);
  await page.mouse.up();
  await expect(studio.getByText('Manual framing', { exact: true })).toBeVisible();
  await expect(studio.getByText('Drag the preview or use the controls below.', { exact: true }))
    .toBeVisible();

  const horizontal = studio.getByRole('slider', { name: 'Left or right' });
  const vertical = studio.getByRole('slider', { name: 'Up or down' });
  const zoom = studio.getByRole('slider', { name: 'Zoom' });
  const expectedPercent = Math.round(expectedX * 100);
  await expect(horizontal).toHaveAttribute('aria-valuetext', `${expectedPercent} percent from left`);
  await expect(vertical).toHaveAttribute('aria-valuetext', '50 percent from top');
  await expect(zoom).toHaveAttribute('aria-valuetext', '100 percent zoom');
  await expect(studio.getByText(`${expectedPercent}% from left`, { exact: true })).toBeVisible();
  await expect(studio.getByText('50% from top', { exact: true })).toBeVisible();
  await expect(studio.getByText('100%', { exact: true })).toBeVisible();
  const reset = studio.getByRole('button', { name: 'Reset to automatic' });
  const horizontalHandle = await horizontal.elementHandle();
  expect(horizontalHandle).not.toBeNull();
  expect(await reset.evaluate((element, range) => (
    element.compareDocumentPosition(range) & Node.DOCUMENT_POSITION_FOLLOWING
  ) !== 0, horizontalHandle!)).toBe(true);
  await expect(studio.locator('.cover-studio__canvas')).toHaveCSS('touch-action', 'pan-y pinch-zoom');

  await reset.click();
  await expect(studio.getByText('Automatic framing', { exact: true })).toBeVisible();
  await expect(studio.getByRole('slider')).toHaveCount(0);
  await expect.poll(position).toBe('50% 50%');
  await studio.getByRole('button', { name: 'Adjust framing' }).click();
  await horizontal.focus();
  await horizontal.press('End');
  await expect(horizontal).toHaveAttribute('aria-valuetext', '100 percent from left');
  await horizontal.press('Home');
  await horizontal.press('PageUp');
  await horizontal.press('ArrowRight');
  await expect(horizontal).toHaveAttribute('aria-valuetext', '11 percent from left');
  await zoom.press('End');
  await expect(zoom).toHaveAttribute('aria-valuetext', '200 percent zoom');
  await expect(studio.getByRole('status'))
    .toContainText('Cover positioned 11 percent from left');
  expect(records(audit, 'transform')).toHaveLength(transformCount);
  expect(records(audit, 'publication')).toHaveLength(0);
});

test('upload validation stays inside the Studio and resets the native picker', async ({ page }) => {
  const audit = await openManagerStudio(page);
  const studio = page.getByRole('dialog', { name: 'Cover Studio' });
  const input = page.getByLabel('Choose photo');

  await input.setInputFiles({
    name: 'not-a-cover.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from('GIF89a'),
  });

  const alert = studio.getByRole('alert');
  await expect(alert).toContainText('JPEG, PNG, WebP, or HEIC');
  await expect(alert).toBeFocused();
  await expect(input).toHaveValue('');
  expect(records(audit, 'draft')).toHaveLength(0);
});

test('an existing upload is inspected once, can be reset to automatic focus, and publishes without retransferring bytes', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page, {
    event: { cover: UPLOAD_COVER },
    mediaPages: { first: { media: [], nextCursor: null } },
  });

  await expect(page.getByRole('radio', { name: 'Upload a photo' })).toBeChecked();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Adjust framing' })).toBeVisible();
  const draft = records(audit, 'draft').find(({ method, path }) => method === 'POST' && path.endsWith('/drafts'));
  expect(draft?.requestBody).toMatchObject({
    source: { kind: 'existing-upload' },
    expectedCoverRevision: 7,
  });
  expect(records(audit, 'transform').filter(({ path }) => path.endsWith('/raw'))).toHaveLength(0);

  await page.getByRole('button', { name: 'Adjust framing' }).click();
  await page.getByRole('slider', { name: 'Left or right' }).press('End');
  await page.getByRole('button', { name: 'Reset to automatic' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Done' }).click();

  expect(records(audit, 'publication')).toHaveLength(1);
  expect(records(audit, 'publication')[0]?.requestBody).toMatchObject({
    expectedRevision: 7,
    source: { kind: 'upload', draftId: 'draft-e2e' },
    focus: { mode: 'auto' },
  });
});

test('a lost publication response reconciles the same operation while the Studio is closed', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    coverScenario: {
      publicationReplies: [{ kind: 'drop' }],
      statusReplies: [{ operationStatus: 'applied', status: 200, includeEvent: true }],
    },
  });
  await choosePreset(page);
  await finishPreset(page, 'Natural');
  await expect(page.getByRole('dialog', { name: 'Cover Studio' }).getByRole('alert'))
    .toContainText('could not be saved');
  await expect(page.getByRole('dialog', { name: 'Cover Studio' })).toHaveCount(0);

  await expect.poll(() => records(audit, 'status').length, {
    timeout: 5_000,
    message: 'Manager-level owner reconciles after the dropped response',
  }).toBe(1);
  await expect(page.getByRole('button', { name: 'Change cover' })).toBeEnabled();
  const publication = records(audit, 'publication')[0]!;
  const status = records(audit, 'status')[0]!;
  const operationId = (publication.requestBody as { operationId: string }).operationId;
  expect(status.path.endsWith(`/publications/${operationId}`)).toBe(true);
  expect(records(audit, 'publication')).toHaveLength(1);
});

test('server Retry-After controls polling and close does not detach the Manager owner', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    coverScenario: {
      publicationReplies: [{ operationStatus: 'preparing', status: 202, retryAfter: '3' }],
      statusReplies: [{ operationStatus: 'applied', status: 200, includeEvent: true }],
    },
  });
  await choosePreset(page);
  await finishPreset(page, 'Warm');
  await expect(page.getByRole('dialog', { name: 'Cover Studio' }).getByRole('status'))
    .toContainText('Preparing cover');
  await expect(page.locator('.cover-preparation')).toBeVisible();
  await expect(page.locator('.cover-preparation--success')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close' }).click();

  await expect.poll(() => records(audit, 'status').length, { timeout: 6_000 }).toBe(1);
  const publication = records(audit, 'publication')[0]!;
  const status = records(audit, 'status')[0]!;
  expect(publication.responseHeaders['retry-after']).toBe('3');
  expect(status.timestamp - publication.timestamp).toBeGreaterThanOrEqual(2_900);
  expect(records(audit, 'publication')).toHaveLength(1);
  await page.getByRole('button', { name: 'Change cover' }).click();
  await expect(page.getByRole('dialog', { name: 'Cover Studio' })).toBeVisible();
  expect(records(audit, 'publication')).toHaveLength(1);
});

test('a hidden document pauses receipt reads and visibility resumes the retained operation immediately', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    coverScenario: {
      publicationReplies: [{ operationStatus: 'preparing', status: 202, retryAfter: '0' }],
      statusReplies: [{ operationStatus: 'applied', status: 200, includeEvent: true }],
    },
  });
  await choosePreset(page);
  await setDocumentVisibility(page, 'hidden');
  await finishPreset(page);
  await page.waitForTimeout(1_200);
  expect(records(audit, 'status')).toHaveLength(0);

  await setDocumentVisibility(page, 'visible');
  await expect.poll(() => records(audit, 'status').length, { timeout: 3_000 }).toBe(1);
  const operationId = (records(audit, 'publication')[0]?.requestBody as { operationId: string }).operationId;
  expect(records(audit, 'status')[0]?.path).toContain(operationId);
  expect(records(audit, 'publication')).toHaveLength(1);
});

test('an applied terminal response without an event performs one guarded event handoff', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    coverScenario: {
      publicationReplies: [{ operationStatus: 'applied', status: 200, includeEvent: false }],
    },
  });
  await choosePreset(page);
  await finishPreset(page);

  await expect(page.getByRole('dialog', { name: 'Cover Studio' })).toHaveCount(0);
  await expect.poll(() => records(audit, 'event-refresh').length).toBe(2);
  expect(records(audit, 'publication')).toHaveLength(1);
});

test('the server-selected receipt outranks cleared browser storage after reload', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const operationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await page.addInitScript(() => sessionStorage.clear());
  const audit = await stubManagerRoutes(page, {
    event: {
      cover: {
        ...EVENT_FIXTURE.cover,
        preparation: {
          operationId,
          status: 'preparing',
          completedSteps: 2,
          requiredSteps: 6,
          retryable: false,
          safeFailureCode: null,
          updatedAt: '2026-08-10T00:00:00.000Z',
        },
      },
    },
    mediaPages: { first: { media: [], nextCursor: null } },
    coverScenario: {
      statusReplies: [{ operationStatus: 'applied', status: 200, includeEvent: true }],
    },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  await expect.poll(() => records(audit, 'status').length, { timeout: 5_000 }).toBe(1);
  expect(records(audit, 'status')[0]?.path).toContain(operationId);
  expect(records(audit, 'publication')).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => (
    sessionStorage.getItem('candidary.cover.operation.event-a')
  ))).toBeNull();
});

test('Manager access recovery resumes the same receipt and never republishes', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    coverScenario: {
      publicationReplies: [{ operationStatus: 'preparing', status: 202, retryAfter: '0' }],
      statusReplies: [
        { kind: 'error', status: 401, code: 'MANAGER_ACCESS_REQUIRED', message: 'Restore access.' },
        { operationStatus: 'applied', status: 200, includeEvent: true },
      ],
    },
  });
  await choosePreset(page);
  await finishPreset(page);
  await expect.poll(() => records(audit, 'status').length, { timeout: 5_000 }).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => records(audit, 'status').length, { timeout: 4_000 }).toBe(2);

  const operationId = (records(audit, 'publication')[0]?.requestBody as { operationId: string }).operationId;
  expect(records(audit, 'status').every(({ path }) => path.endsWith(`/publications/${operationId}`))).toBe(true);
  expect(records(audit, 'publication')).toHaveLength(1);
});

for (const terminal of [
  { name: 'conflict', status: 409, operationStatus: 'conflict' as const, message: 'changed somewhere else' },
  { name: 'permanent failure', status: 503, operationStatus: 'permanent-failed' as const, message: 'could not be started' },
]) {
  test(`${terminal.name} remains terminal without republishing`, async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    const audit = await openManagerStudio(page, {
      mediaPages: { first: { media: [], nextCursor: null } },
      coverScenario: {
        publicationReplies: [{
          operationStatus: terminal.operationStatus,
          status: terminal.status,
          includeEvent: true,
        }],
      },
    });
    await choosePreset(page);
    await finishPreset(page);

    await expect(page.getByRole('dialog', { name: 'Cover Studio' }).getByRole('alert'))
      .toContainText(terminal.message);
    await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(records(audit, 'publication')).toHaveLength(1);
    expect(records(audit, 'status')).toHaveLength(0);
  });
}

test('retryable failure restarts only the retained operation ID', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    coverScenario: {
      publicationReplies: [{
        operationStatus: 'retryable-failed', status: 503, retryable: true,
      }],
      restartReplies: [{ operationStatus: 'preparing', status: 202, retryAfter: '0' }],
      statusReplies: [{ operationStatus: 'applied', status: 200, includeEvent: true }],
    },
  });
  await choosePreset(page);
  await finishPreset(page);
  await page.getByRole('dialog', { name: 'Cover Studio' })
    .getByRole('button', { name: 'Try again' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Cover Studio' })).toHaveCount(0, { timeout: 5_000 });

  const publication = records(audit, 'publication')[0]!;
  const operationId = (publication.requestBody as { operationId: string }).operationId;
  expect(records(audit, 'restart')).toHaveLength(1);
  expect(records(audit, 'restart')[0]?.path.endsWith(`/publications/${operationId}/restart`)).toBe(true);
  expect(records(audit, 'status')[0]?.path.endsWith(`/publications/${operationId}`)).toBe(true);
  expect(records(audit, 'publication')).toHaveLength(1);
});

test('remove, Cancel, repeated browser Back, alert focus trap, and invoker restoration are explicit', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const presetCover: EventView['cover'] = {
    ...EVENT_FIXTURE.cover,
    config: {
      version: 1,
      source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
      effect: 'natural',
    },
    revision: 4,
    hasCover: true,
  };
  const audit = await openManagerStudio(page, {
    event: { cover: presetCover },
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.getByRole('radio', { name: 'Botanical Shadow' }).check();
  await page.goBack();
  const alert = page.getByRole('alertdialog', { name: 'Discard cover changes' });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(alert.getByRole('button', { name: 'Discard draft' })).toBeFocused();
  await alert.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('radio', { name: 'Botanical Shadow' })).toBeFocused();
  await page.goBack();
  await alert.getByRole('button', { name: 'Keep editing' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await alert.getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByRole('button', { name: 'Change cover' })).toBeFocused();
  expect(records(audit, 'publication')).toHaveLength(0);

  await page.getByRole('button', { name: 'Change cover' }).click();
  await page.getByRole('button', { name: 'Remove cover' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  expect(records(audit, 'publication')[0]?.requestBody).toMatchObject({ source: { kind: 'none' } });
});

const PROFILE_CASES = [
  { profile: 'short-lookup', width: 360, height: 600, lookup: true, expanded: false },
  { profile: 'compact-default', width: 390, height: 844, lookup: false, expanded: false },
  { profile: 'standard-default', width: 391, height: 844, lookup: false, expanded: false },
  { profile: 'framed-default', width: 700, height: 760, lookup: false, expanded: false },
  { profile: 'compact-expanded', width: 390, height: 844, lookup: false, expanded: true },
  { profile: 'wide-expanded', width: 391, height: 844, lookup: false, expanded: true },
] as const;

const VISUAL_FIXTURES = [
  { name: 'portrait-edge-dark', buffer: PORTRAIT_EDGE_DARK_COVER },
  { name: 'landscape-centered-light', buffer: LANDSCAPE_CENTERED_LIGHT_COVER },
] as const;

const PROFILE_BOUNDARIES = [
  { width: 360, height: 599, lookup: true, expanded: false, profile: 'short-lookup' },
  { width: 360, height: 600, lookup: true, expanded: false, profile: 'short-lookup' },
  { width: 361, height: 600, lookup: true, expanded: false, profile: 'compact-default' },
  { width: 360, height: 601, lookup: true, expanded: false, profile: 'compact-default' },
  { width: 390, height: 844, lookup: false, expanded: false, profile: 'compact-default' },
  { width: 391, height: 844, lookup: false, expanded: false, profile: 'standard-default' },
  { width: 699, height: 760, lookup: false, expanded: false, profile: 'standard-default' },
  { width: 700, height: 759, lookup: false, expanded: false, profile: 'standard-default' },
  { width: 700, height: 760, lookup: false, expanded: false, profile: 'framed-default' },
] as const;

async function openGuestProfile(
  page: Page,
  profileCase: typeof PROFILE_CASES[number],
  cover: Buffer,
) {
  await page.setViewportSize({ width: profileCase.width, height: profileCase.height });
  const coverView = {
    ...GUEST_EVENT_FIXTURE.cover,
    revision: 23,
    hasCover: true,
    available2xProfiles: [profileCase.profile],
  };
  const event: GuestEventView = profileCase.lookup
    ? {
        ...GUEST_EVENT_FIXTURE,
        cover: coverView,
        uploadsEnabled: false,
        phase: 'rsvp-primary',
        rsvpState: 'open',
        rsvpAccess: 'editable',
        rsvpDeadlineAt: '2026-09-05T23:59:59.999Z',
        rsvpDeadlineDate: '2026-09-05',
      }
    : {
        ...GUEST_EVENT_FIXTURE,
        cover: coverView,
        welcomeMessage: profileCase.expanded
          ? 'Come celebrate every luminous, funny, tender, unexpected moment with us. '.repeat(4)
          : GUEST_EVENT_FIXTURE.welcomeMessage,
      };
  const audit = await stubGuestRoutes(page, {
    eventReplies: [event],
    cover,
    rsvpSession: false,
  });
  await page.goto(`/event/${event.slug}`);
  if (profileCase.lookup) await expect(page.getByRole('button', { name: 'Find my invitation' })).toBeVisible();
  if (profileCase.expanded) await page.getByRole('button', { name: 'Read full welcome' }).click();
  const reader = page.locator('.photo-drop__hero .responsive-cover');
  await expect(reader).toHaveAttribute('data-cover-profile', profileCase.profile);
  await expect(reader.locator('img')).toBeVisible();
  return { audit, reader };
}

for (const profileCase of PROFILE_CASES) {
  for (const fixture of VISUAL_FIXTURES) {
    test(`${profileCase.profile} renders ${fixture.name} with only current advertised candidates`, async ({ page }, testInfo) => {
      desktopOnly(testInfo);
      const { audit, reader } = await openGuestProfile(page, profileCase, fixture.buffer);
      const sourceSet = await reader.locator('source[type="image/webp"]').getAttribute('srcset');
      expect(sourceSet).toContain(`/cover/23/${profileCase.profile}/1x.webp 1x`);
      expect(sourceSet).toContain(`/cover/23/${profileCase.profile}/2x.webp 2x`);
      expect(await reader.locator('img').getAttribute('srcset'))
        .toContain(`/cover/23/${profileCase.profile}/2x.jpeg 2x`);
      const currentCandidate = await reader.locator('img').evaluate((element) => (
        (element as HTMLImageElement).currentSrc
      ));
      expect(currentCandidate).toMatch(new RegExp(`/cover/23/${profileCase.profile}/(?:1x|2x)\\.(?:webp|jpeg)$`, 'u'));
      expect(await reader.evaluate((element) => Array.from(element.children).map((child) => (
        child.tagName === 'PICTURE' ? 'picture' : child.className
      )))).toEqual(['picture', 'responsive-cover__treatment', 'responsive-cover__scrim']);
      await expect(reader.locator('xpath=following-sibling::*[1]')).toHaveClass(/photo-drop__hero-copy/u);
      for (const request of records(audit, 'slot')) {
        expect(request.path).toMatch(/^\/api\/event\/maya-theo\/cover\/23\//u);
        expect(request.path).not.toContain('/master');
        expect(request.path).not.toContain('/22/');
      }
      await settleRendering(page, { parkPointer: true });
      await expect(page.locator('.photo-drop__hero')).toHaveScreenshot(
        `${profileCase.profile}-${fixture.name}.png`,
      );
    });
  }
}

test('responsive profile boundaries map the exact width and height edges', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  for (const boundary of PROFILE_BOUNDARIES) {
    const profileCase = {
      ...boundary,
      profile: boundary.profile,
    } as typeof PROFILE_CASES[number];
    const { reader } = await openGuestProfile(page, profileCase, LANDSCAPE_CENTERED_LIGHT_COVER);
    await expect(reader).toHaveAttribute('data-cover-profile', boundary.profile);
  }
});

async function installVisualViewport(page: Page, height: number) {
  await page.addInitScript((visualHeight) => {
    const events = new EventTarget();
    const visualViewport = {
      width: window.innerWidth,
      height: visualHeight,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
  }, height);
}

async function geometryPage(
  browser: Browser,
  width: number,
  height: number,
  visualHeight?: number,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width, height },
  });
  const page = await context.newPage();
  if (visualHeight !== undefined) await installVisualViewport(page, visualHeight);
  await openManagerStudio(page);
  return { context, page };
}

test('source and style radios retain 20px glyphs, 44px labels, and a visible file-focus proxy at 320 and 390', async ({ browser }, testInfo) => {
  desktopOnly(testInfo);
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    const { context, page } = await geometryPage(browser, viewport.width, viewport.height);
    try {
      const studio = page.getByRole('dialog', { name: 'Cover Studio' });
      const assertRadioGeometry = async (selector: string) => {
        for (const radio of await studio.locator(selector).all()) {
          const geometry = await radio.evaluate((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const label = element.closest('label');
            const labelRect = label?.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
              border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
              computedWidth: style.width,
              minHeight: style.minHeight,
              accentColor: style.accentColor,
              labelWidth: labelRect?.width ?? 0,
              labelHeight: labelRect?.height ?? 0,
            };
          });
          expect(geometry.width).toBe(20);
          expect(geometry.height).toBe(20);
          expect(geometry.padding).toEqual(['0px', '0px', '0px', '0px']);
          expect(geometry.border).toEqual(['0px', '0px', '0px', '0px']);
          expect(geometry.computedWidth).not.toBe('100%');
          expect(geometry.minHeight).not.toBe('48px');
          expect(geometry.accentColor).toBe('rgb(63, 109, 149)');
          expect(geometry.labelWidth).toBeGreaterThanOrEqual(44);
          expect(geometry.labelHeight).toBeGreaterThanOrEqual(44);
        }
      };

      await assertRadioGeometry('.cover-source-picker input[type="radio"]');
      const upload = studio.locator('.cover-source-picker__upload');
      await expect(upload).toHaveCSS('border-top-style', 'dashed');
      await expect(studio.locator('.cover-source-picker__upload-choice')).toHaveCSS('min-width', '0px');
      const uploadNameLines = await studio.locator(
        '.cover-source-picker__upload .cover-source-picker__name',
      ).evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size;
      });
      expect(uploadNameLines).toBeLessThanOrEqual(2);

      const file = studio.locator('.cover-source-picker__file');
      await studio.getByRole('radio', { name: 'Upload a photo' }).focus();
      await page.keyboard.press('Tab');
      await expect(file).toBeFocused();
      const proxy = studio.locator('.cover-source-picker__file-proxy');
      const outline = await proxy.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          style: style.outlineStyle,
          width: style.outlineWidth,
          color: style.outlineColor,
          offset: Number.parseFloat(style.outlineOffset),
        };
      });
      expect(outline).toEqual({
        style: 'solid',
        width: '2px',
        color: 'rgb(44, 92, 133)',
        offset: 2,
      });

      const warmLinen = studio.getByRole('radio', { name: /^Warm Linen/u });
      await warmLinen.check();
      const selectedSource = warmLinen.locator('xpath=ancestor::label');
      await expect(selectedSource).toContainText('Warm Linen');
      const sourceRing = await selectedSource.evaluate((element) => getComputedStyle(element).boxShadow);
      expect(sourceRing).toContain('rgb(63, 109, 149)');
      expect(sourceRing).toContain('2px');

      await studio.getByRole('button', { name: 'Continue' }).click();
      await assertRadioGeometry('.cover-style-picker input[type="radio"]');
      const film = studio.getByRole('radio', { name: /^Film/u });
      await film.check();
      const selectedStyle = film.locator('xpath=ancestor::label');
      await expect(selectedStyle).toContainText('Film');
      const styleRing = await selectedStyle.evaluate((element) => getComputedStyle(element).boxShadow);
      expect(styleRing).toContain('rgb(63, 109, 149)');
      expect(styleRing).toContain('2px');
    } finally {
      await context.close();
    }
  }
});

test('Done keeps the preset receipt visible before dispatch and while preparing or retryable failed', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    coverScenario: {
      publicationReplies: [{
        operationStatus: 'preparing',
        status: 202,
        retryAfter: '1',
      }],
      statusReplies: [{
        operationStatus: 'retryable-failed',
        status: 503,
        retryable: true,
        includeEvent: true,
      }],
    },
  });
  await choosePreset(page);
  await page.getByRole('radio', { name: /^Film/u }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  const studio = page.getByRole('dialog', { name: 'Cover Studio' });
  const receipt = studio.locator('.cover-studio__receipt');
  await expect(receipt).toContainText('Warm Linen · Film');
  await expect(receipt).toContainText('Guests see this at the top of RSVP and photo delivery.');
  await expect(receipt).toContainText(
    'Your current cover stays live until the new one is completely ready. If anything fails, nothing changes.',
  );
  const receiptText = await receipt.textContent();

  await studio.getByRole('button', { name: 'Done' }).click();
  const preparing = studio.getByRole('status');
  await expect(preparing).toContainText('Preparing cover');
  await expect(receipt).toHaveText(receiptText!);
  const preparingHandle = await preparing.elementHandle();
  expect(preparingHandle).not.toBeNull();
  expect(await receipt.evaluate((element, status) => (
    element.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING
  ) !== 0, preparingHandle!)).toBe(true);
  await expect(studio.getByRole('button', { name: 'Back' })).toBeDisabled();
  await expect(studio.getByRole('button', { name: 'Done' })).toBeDisabled();

  await expect.poll(() => records(audit, 'status').length, { timeout: 4_000 }).toBe(1);
  const retry = studio.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  await expect(receipt).toHaveText(receiptText!);
  const retryHandle = await retry.elementHandle();
  expect(retryHandle).not.toBeNull();
  expect(await receipt.evaluate((element, action) => (
    element.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING
  ) !== 0, retryHandle!)).toBe(true);
  expect(records(audit, 'publication')).toHaveLength(1);
  expect(records(audit, 'status')).toHaveLength(1);
});

test('preset styles load five static effect thumbnails without draft or preview requests', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const audit = await openManagerStudio(page);
  await choosePreset(page);
  const items = page.locator('.cover-style-picker li');
  await expect(items).toHaveCount(5);
  for (const item of await items.all()) await expect(item).toHaveAttribute('data-thumbnail-state', 'ready');
  const images = page.locator('.cover-style-picker img');
  await expect(images).toHaveCount(5);
  for (const thumbnail of await images.all()) await expect(thumbnail).toBeVisible();
  await expect.poll(() => images.evaluateAll((nodes) => nodes.every((node) => {
    const image = node as HTMLImageElement;
    return image.complete && image.naturalWidth > 0;
  }))).toBe(true);
  const effects = ['natural', 'warm', 'film', 'soft', 'monochrome'];
  expect(await images.evaluateAll((nodes) => nodes.map((node) => (
    new URL((node as HTMLImageElement).src).pathname
  )))).toEqual(effects.map((effect) => (
    `/assets/event-covers/v1/warm-linen/${effect}/standard-default-1x.webp`
  )));
  for (const name of ['Natural', 'Warm', 'Film', 'Soft', 'Monochrome']) {
    await expect(page.getByRole('radio', { name: new RegExp(`^${name}`, 'u') })).toBeEnabled();
  }
  for (const kind of ['draft', 'preview', 'transform', 'publication'] as const) {
    expect(records(audit, kind)).toHaveLength(0);
  }
});

test('missing preset style artwork keeps its named radio usable without upload fallbacks', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.route(
    '**/assets/event-covers/v1/warm-linen/film/standard-default-1x.webp',
    (route) => route.fulfill({ status: 404, body: 'Missing fixture artwork.' }),
  );
  const audit = await openManagerStudio(page);
  await choosePreset(page);
  const film = page.getByRole('radio', { name: /^Film/u });
  await expect(film).toBeEnabled();
  await film.check();
  await expect(film).toBeChecked();
  const image = page.locator('.cover-style-picker li', { has: film }).locator('img');
  await expect.poll(() => image.evaluate((node) => {
    const thumbnail = node as HTMLImageElement;
    return thumbnail.complete && thumbnail.naturalWidth === 0;
  })).toBe(true);
  await expect(page.locator('.cover-style-picker__state')).toHaveCount(0);
  for (const kind of ['draft', 'preview', 'transform', 'publication'] as const) {
    expect(records(audit, kind)).toHaveLength(0);
  }
});

test('default, compact, and short Studio modes size the real guest frame and retain one reachable scroller', async ({ browser }, testInfo) => {
  desktopOnly(testInfo);
  for (const geometry of [
    { width: 320, height: 568, mode: 'default', guestHeight: 144 },
    { width: 390, height: 844, mode: 'default', guestHeight: 144 },
    { width: 640, height: 450, mode: 'compact', guestHeight: 96 },
    { width: 320, height: 180, mode: 'short', guestHeight: 96 },
  ] as const) {
    const { context, page } = await geometryPage(browser, geometry.width, geometry.height);
    try {
      const studio = page.getByRole('dialog', { name: 'Cover Studio' });
      await expect(studio).toHaveAttribute('data-viewport', geometry.mode);
      const guest = studio.locator('.cover-studio__canvas .event-appearance-canvas__guest');
      const guestGeometry = await guest.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        minHeight: Number.parseFloat(getComputedStyle(element).minHeight),
      }));
      expect(guestGeometry.minHeight).toBe(geometry.guestHeight);
      expect(guestGeometry.height).toBeGreaterThanOrEqual(geometry.guestHeight);
      expect(guestGeometry.height).toBeLessThanOrEqual(geometry.guestHeight + 1);
      const guestHandle = await guest.elementHandle();
      expect(guestHandle).not.toBeNull();
      for (const content of await guest.locator(
        '.event-appearance-canvas__event, .event-appearance-canvas__welcome, .event-appearance-canvas__action',
      ).all()) {
        await expect(content).toBeVisible();
        const containment = await content.evaluate((element, frame) => {
          const contentRect = element.getBoundingClientRect();
          const frameRect = frame.getBoundingClientRect();
          return {
            className: element.className,
            content: { left: contentRect.left, right: contentRect.right, top: contentRect.top, bottom: contentRect.bottom },
            frame: { left: frameRect.left, right: frameRect.right, top: frameRect.top, bottom: frameRect.bottom },
            inside: contentRect.left >= frameRect.left - 1
            && contentRect.right <= frameRect.right + 1
            && contentRect.top >= frameRect.top - 1
            && contentRect.bottom <= frameRect.bottom + 1,
          };
        }, guestHandle!);
        expect(containment.inside, JSON.stringify(containment)).toBe(true);
      }

      const scrollableRegions = await studio.evaluate((element) => (
        [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))]
          .filter((candidate) => {
            const overflow = getComputedStyle(candidate).overflowY;
            return (overflow === 'auto' || overflow === 'scroll')
              && candidate.scrollHeight > candidate.clientHeight + 1;
          }).length
      ));
      expect(scrollableRegions).toBe(1);
      const documentSize = await measureDocument(page);
      expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
      expect(await measureViewportEscapes(studio)).toEqual([]);

      if (geometry.width === 320 && geometry.height === 568) {
        await expect(studio.locator('.cover-source-picker__upload')).toBeInViewport();
        await expect(studio.locator('.cover-studio__footer')).toBeInViewport();
        const header = studio.locator('.cover-studio__header');
        const cancel = header.getByRole('button', { name: 'Cancel' });
        const title = header.getByRole('heading', { name: 'Choose a cover' });
        const counter = header.getByText('Step 1 of 3', { exact: true });
        expect((await measureTarget(header)).height).toBe(56);
        expect(await measureSeparation(cancel, title)).toBeGreaterThan(0);
        expect(await measureSeparation(title, counter)).toBeGreaterThan(0);
        const headerGeometry = await header.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return Array.from(element.children).map((child) => {
            const rect = child.getBoundingClientRect();
            return {
              withinHeader: rect.left >= bounds.left && rect.right <= bounds.right
                && rect.top >= bounds.top && rect.bottom <= bounds.bottom,
              withinViewport: rect.left >= 0 && rect.right <= document.documentElement.clientWidth,
            };
          });
        });
        expect(headerGeometry.every(({ withinHeader, withinViewport }) => (
          withinHeader && withinViewport
        ))).toBe(true);
        expect(await title.evaluate((element) => ({
          horizontal: element.scrollWidth <= element.clientWidth,
          vertical: element.scrollHeight <= element.clientHeight + 1,
        }))).toEqual({ horizontal: true, vertical: true });
      }

      const footer = studio.locator('.cover-studio__footer');
      await footer.scrollIntoViewIfNeeded();
      expect((await measureFold(page, footer)).visible).toBeGreaterThan(0);
      for (const action of await footer.getByRole('button').all()) {
        expect((await measureTarget(action)).height).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await context.close();
    }
  }
});

test('sheet/dialog, compact keyboard, 200%, and 400% geometries retain one usable scroll region', async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  desktopOnly(testInfo);
  for (const geometry of [
    { label: 'sheet-760', width: 760, height: 700, mode: 'default', radius: '0px', snapshot: true },
    { label: 'dialog-761', width: 761, height: 700, mode: 'default', radius: '12px', snapshot: true },
    { label: 'phone-320', width: 320, height: 568, mode: 'default', radius: '0px', snapshot: false },
    { label: 'phone-390', width: 390, height: 844, mode: 'default', radius: '0px', snapshot: false },
    { label: 'zoom-200', width: 640, height: 450, mode: 'compact', radius: '0px', snapshot: true },
    { label: 'zoom-400', width: 320, height: 180, mode: 'short', radius: '0px', snapshot: true },
  ] as const) {
    const { context, page } = await geometryPage(browser, geometry.width, geometry.height);
    const studio = page.getByRole('dialog', { name: 'Cover Studio' });
    await expect(studio).toHaveAttribute('data-viewport', geometry.mode);
    await expect(studio).toHaveCSS('border-radius', geometry.radius);
    const measures = await studio.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      scrollableRegions: [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))]
        .filter((candidate) => {
          const overflow = getComputedStyle(candidate).overflowY;
          return (overflow === 'auto' || overflow === 'scroll')
            && candidate.scrollHeight > candidate.clientHeight + 1;
        }).length,
      viewportMeta: document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content ?? '',
    }));
    expect(measures.documentWidth, geometry.label).toBeLessThanOrEqual(measures.viewportWidth + 1);
    expect(measures.scrollableRegions, `${geometry.label} usable scroll regions`).toBe(1);
    // The document measure above cannot see this. `.cover-studio__controls` scrolls vertically, so a
    // control pushed past the right edge is absorbed by that pane instead of widening the page — the
    // document stayed honest at 390 while `Choose photo` sat at x=411, off a 390px screen. Only an
    // element-level scan reports it, and the deliberate preset scroller is exempt from it by declaring
    // `overscroll-behavior-x: contain`.
    expect(await measureViewportEscapes(studio), `${geometry.label} escapes the viewport`).toEqual([]);
    expect(measures.viewportMeta).not.toContain('user-scalable=no');
    if (geometry.mode === 'short') {
      expect(measures.overflowY).toBe('auto');
      expect(measures.scrollHeight).toBeGreaterThan(measures.clientHeight);
    }
    for (const button of await studio.getByRole('button').all()) {
      if (!await button.isVisible()) continue;
      const box = await button.boundingBox();
      expect(box?.height, `${geometry.label} ${await button.textContent()}`).toBeGreaterThanOrEqual(44);
    }
    const heading = studio.getByRole('heading', { name: 'Choose a cover' });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    const footer = studio.locator('.cover-studio__footer');
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeInViewport();
    expect(await footer.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)))
      .toBeGreaterThanOrEqual(12);
    if (geometry.snapshot) {
      await settleRendering(page, { parkPointer: true });
      await expect(studio).toHaveScreenshot(`studio-${geometry.label}.png`);
    }
    await context.close();
  }

  for (const [visualHeight, mode] of [[499, 'compact'], [500, 'default']] as const) {
    const { context, page } = await geometryPage(browser, 390, 844, visualHeight);
    const studio = page.getByRole('dialog', { name: 'Cover Studio' });
    await expect(studio).toHaveAttribute('data-viewport', mode);
    if (visualHeight === 499) {
      await settleRendering(page, { parkPointer: true });
      await expect(studio).toHaveScreenshot('studio-keyboard-compact.png');
    }
    await context.close();
  }
});

test('guest WebP and JPEG failure emits once, refreshes once, and resets on a newer revision', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  const initial: GuestEventView = {
    ...GUEST_EVENT_FIXTURE,
    cover: { ...GUEST_EVENT_FIXTURE.cover, revision: 51, hasCover: true },
  };
  const refreshed: GuestEventView = {
    ...initial,
    cover: { ...initial.cover, revision: 52 },
  };
  const observations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('cover_unavailable')) {
      observations.push(message.text());
    }
  });
  const audit = await stubGuestRoutes(page, {
    eventReplies: [initial, refreshed],
    coverSlotFailures: { webp: 1, jpeg: 1 },
  });
  await page.goto(`/event/${initial.slug}`);
  await expect(page.locator('.responsive-cover__image')).toHaveAttribute('src', /\/52\//u, { timeout: 5_000 });
  expect(records(audit, 'event-refresh')).toHaveLength(2);
  expect(observations).toHaveLength(1);
  expect(observations[0]).not.toContain('events/');
  await page.waitForTimeout(500);
  expect(records(audit, 'event-refresh')).toHaveLength(2);
});

test('guest final fallback is a gradient with no broken image and no unchanged-revision refresh loop', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  const sameRevision: GuestEventView = {
    ...GUEST_EVENT_FIXTURE,
    cover: { ...GUEST_EVENT_FIXTURE.cover, revision: 61, hasCover: true },
  };
  const audit = await stubGuestRoutes(page, {
    eventReplies: [sameRevision, sameRevision],
    coverSlotFailures: { webp: 1, jpeg: 1 },
  });
  await page.goto(`/event/${sameRevision.slug}`);
  const cover = page.locator('.photo-drop__hero .responsive-cover');
  await expect(cover).toHaveClass(/responsive-cover--gradient/u);
  await expect(cover.locator('img')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(records(audit, 'event-refresh')).toHaveLength(2);
});

test('Manager WebP and JPEG recovery refreshes once and resets on the newer event revision', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const initial: EventView = {
    ...EVENT_FIXTURE,
    cover: { ...UPLOAD_COVER, revision: 71 },
  };
  const refreshed: EventView = {
    ...initial,
    cover: { ...initial.cover, revision: 72 },
  };
  const observations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('cover_unavailable')) {
      observations.push(message.text());
    }
  });
  const audit = await stubManagerRoutes(page, {
    event: initial,
    mediaPages: { first: { media: [], nextCursor: null } },
    cover: LANDSCAPE_CENTERED_LIGHT_COVER,
    coverScenario: {
      eventReplies: [initial, refreshed],
      slotFailures: { webp: 1, jpeg: 1 },
    },
  });
  await page.goto(`/manage/event/${initial.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const canvas = page.getByRole('region', { name: 'Event appearance editor' });
  await expect(canvas.locator('.responsive-cover__image')).toHaveAttribute('src', /\/72\//u, { timeout: 5_000 });
  expect(records(audit, 'event-refresh')).toHaveLength(2);
  expect(observations).toHaveLength(1);
  expect(observations[0]).not.toContain(initial.id);
});

test('Manager final fallback is a gradient with one unchanged-revision refresh and no broken image', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  const sameRevision: EventView = {
    ...EVENT_FIXTURE,
    cover: { ...UPLOAD_COVER, revision: 81 },
  };
  const audit = await stubManagerRoutes(page, {
    event: sameRevision,
    mediaPages: { first: { media: [], nextCursor: null } },
    coverScenario: {
      eventReplies: [sameRevision, sameRevision],
      slotFailures: { webp: 1, jpeg: 1 },
    },
  });
  await page.goto(`/manage/event/${sameRevision.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const cover = page.locator('.event-appearance-canvas .responsive-cover');
  await expect(cover).toHaveClass(/responsive-cover--gradient/u);
  await expect(cover.locator('img')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(records(audit, 'event-refresh')).toHaveLength(2);
});

test('reduced motion keeps focus and removes nonessential Studio transitions', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openManagerStudio(page);
  const studio = page.getByRole('dialog', { name: 'Cover Studio' });
  await expect(page.getByRole('heading', { name: 'Choose a cover' })).toBeFocused();
  expect(['0s', '1e-05s']).toContain(
    await studio.evaluate((element) => getComputedStyle(element).transitionDuration),
  );
  await choosePreset(page);
  await expect(page.getByRole('heading', { name: 'Choose a style' })).toBeFocused();
});

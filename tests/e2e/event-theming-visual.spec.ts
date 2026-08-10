import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  PHOTOGRAPHIC_COVER,
  UPLOAD_EFFECT_COVERS,
} from './fixtures/cover-images';
import {
  EVENT_FIXTURE,
  GUEST_EVENT_FIXTURE,
  eventTheme,
  stubGuestRoutes,
  stubManagerRoutes,
} from './fixtures/routes';
import { LONG_FILENAME, TEST_NOTE } from './fixtures/ui-data';
import { settleRendering } from './helpers/rendering';

const IMAGE = {
  name: LONG_FILENAME.replace(/\.HEIC$/u, '.png'),
  mimeType: 'image/png',
  buffer: PHOTOGRAPHIC_COVER,
};

const COVER_THEME_CASES = [
  { id: 'candidary-default', uploadEffect: 'natural' },
  { id: 'garden-party', uploadEffect: 'warm' },
  { id: 'midnight-film', uploadEffect: 'soft' },
  { id: 'coastal-light', uploadEffect: 'monochrome' },
] as const;

async function settle(page: Page) {
  await settleRendering(page, { parkPointer: true });
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

test.describe('mobile event-theme visual evidence', () => {
  test.beforeEach(({ page }, testInfo) => {
    void page;
    test.skip(testInfo.project.name === 'desktop', 'Mobile baseline.');
  });

  test('Candidary Default cover keeps the localized scrim and first-fold hierarchy', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubGuestRoutes(page, {
      event: {
        theme: eventTheme('candidary-default'),
        cover: { ...GUEST_EVENT_FIXTURE.cover, hasCover: true },
      },
    });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await expect(page.locator('.photo-drop__hero .responsive-cover--image')).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot('guest-default-cover-390.png');
  });

  test('Candidary Default Notes use the corrected form and divider', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1300 });
    await stubGuestRoutes(page, {
      event: { theme: eventTheme('candidary-default') },
      messages: [TEST_NOTE],
    });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await page.locator('.event-extra summary').filter({ hasText: 'Guest notes' }).click();
    await expect(page.locator('.notes-feed li')).toHaveCount(1);
    await settle(page);
    await expect(page.locator('.guest-secondary')).toHaveScreenshot('guest-default-notes-390.png');
  });

  test('Garden Party cover preserves the guest first fold', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubGuestRoutes(page, {
      event: {
        theme: eventTheme('garden-party'),
        cover: { ...GUEST_EVENT_FIXTURE.cover, hasCover: true },
      },
    });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await expect(page.locator('.photo-drop__hero .responsive-cover--image')).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot('guest-garden-cover-390.png');
  });

  test('Midnight Film review retains themed progress paint at 320', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    let release!: () => void;
    const reservation = new Promise<void>((resolve) => { release = resolve; });
    await stubGuestRoutes(page, { event: { theme: eventTheme('midnight-film') } });
    await page.route(`**/api/event/${EVENT_FIXTURE.slug}/uploads/batch`, async (route) => {
      await reservation;
      await route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR', message: 'Unavailable.' } });
    });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await page.getByLabel('Your name').fill('Taylor Morgan');
    await page.locator('input[data-photo-source="library"]').setInputFiles(IMAGE);
    await page.getByRole('button', { name: 'Send 1 photo' }).click();
    await expect(page.getByText('Getting ready')).toBeVisible();
    await settle(page);
    await expect(page.locator('.photo-drop--review'))
      .toHaveScreenshot('guest-midnight-review-progress-320.png');
    release();
  });

  test('Coastal Light entry preserves the name and source hierarchy', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubGuestRoutes(page, { event: { theme: eventTheme('coastal-light') } });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await expect(page.getByLabel('Your name')).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot('guest-coastal-entry-390.png');
  });

  test('Coastal Light terminal receipt remains unmistakably delivered', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubGuestRoutes(page, { event: { theme: eventTheme('coastal-light') } });
    await stubSuccessfulUpload(page);
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await page.getByLabel('Your name').fill('Taylor Morgan');
    await page.locator('input[data-photo-source="library"]').setInputFiles(IMAGE);
    await page.getByRole('button', { name: 'Send 1 photo' }).click();
    await expect(page.getByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot('guest-coastal-receipt-390.png');
  });

  test('manager Event appearance keeps global chrome outside the preview', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubManagerRoutes(page, {
      mediaPages: { first: { media: [], nextCursor: null } },
    });
    await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Event appearance editor' })).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await settle(page);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(844);
    await expect(page).toHaveScreenshot('manager-event-appearance-390.png', { fullPage: true });
  });

  for (const themeCase of COVER_THEME_CASES) {
    test(`${themeCase.id} keeps an immutable preset inside the themed Manager canvas`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await stubManagerRoutes(page, {
        event: {
          theme: eventTheme(themeCase.id),
          cover: {
            ...EVENT_FIXTURE.cover,
            config: {
              version: 1,
              source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
              effect: 'film',
            },
            revision: 4,
            hasCover: true,
            surfaceTreatment: 'film-grain-v1',
          },
        },
        mediaPages: { first: { media: [], nextCursor: null } },
      });
      await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const canvas = page.locator('.event-appearance-canvas');
      await expect(canvas.locator('.responsive-cover--image')).toBeVisible();
      await settle(page);
      await expect(canvas).toHaveScreenshot(`manager-${themeCase.id}-preset-film.png`);
    });

    test(`${themeCase.id} keeps the ${themeCase.uploadEffect} upload effect inside the themed Manager canvas`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await stubManagerRoutes(page, {
        event: {
          theme: eventTheme(themeCase.id),
          cover: {
            ...EVENT_FIXTURE.cover,
            config: {
              version: 1,
              source: { kind: 'upload' },
              focus: { mode: 'manual', x: 0.5, y: 0.5, zoom: 1 },
              effect: themeCase.uploadEffect,
            },
            revision: 5,
            hasCover: true,
          },
        },
        mediaPages: { first: { media: [], nextCursor: null } },
        cover: UPLOAD_EFFECT_COVERS[themeCase.uploadEffect],
      });
      await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const canvas = page.locator('.event-appearance-canvas');
      await expect(canvas.locator('.responsive-cover--image')).toBeVisible();
      await settle(page);
      await expect(canvas).toHaveScreenshot(
        `manager-${themeCase.id}-upload-${themeCase.uploadEffect}.png`,
      );
    });
  }
});

test('Midnight Film full-screen gallery holds a 1280 by 900 desktop composition', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Desktop baseline.');
  await page.setViewportSize({ width: 1280, height: 900 });
  await stubGuestRoutes(page, {
    event: { theme: eventTheme('midnight-film') },
    gallery: [
      {
        id: 'media-a',
        originalFilename: LONG_FILENAME,
        guestName: 'Avery Stone',
        caption: LONG_FILENAME,
        publicationStatus: 'published',
        uploadState: 'stored',
        width: 1200,
        height: 900,
        createdAt: '2026-07-29T12:00:00Z',
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `media-${index + 1}`,
        originalFilename: `moment-${index + 1}.jpg`,
        guestName: 'Avery Stone',
        caption: `Moment ${index + 1}`,
        publicationStatus: 'published' as const,
        uploadState: 'stored' as const,
        width: 1200,
        height: 900,
        createdAt: `2026-07-29T12:00:0${index}Z`,
      })),
    ],
  });
  await page.goto(`/event/${EVENT_FIXTURE.slug}/fullscreen`);
  await expect(page.locator('.fullscreen figure')).toHaveCount(6);
  await settle(page);
  await expect(page).toHaveScreenshot('fullscreen-midnight-1280x900.png');
});

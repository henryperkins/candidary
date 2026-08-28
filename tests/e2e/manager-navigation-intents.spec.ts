import { expect, test, type Page } from '@playwright/test';

import { MANAGER_MEDIA_PAGE_SIZE } from '../../shared/constants';
import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';

const managerGalleryUrl = `/manage/event/${EVENT_FIXTURE.id}?section=gallery`;
const managerSettingsUrl = `/manage/event/${EVENT_FIXTURE.id}?section=settings`;
const e2eOrigin = 'http://127.0.0.1:4173';
const rotatedManagementLink = 'https://example.test/manage/replacement-id.replacement-secret';
const libraryRows = makeMedia(96, 'unpublished');
const guestRows = makeMedia(6, 'unpublished').map((row, index) => ({
  ...row,
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
}));
const libraryPages = {
  first: { media: libraryRows.slice(0, MANAGER_MEDIA_PAGE_SIZE), nextCursor: 'library-2' },
  'library-2': {
    media: libraryRows.slice(MANAGER_MEDIA_PAGE_SIZE, MANAGER_MEDIA_PAGE_SIZE * 2),
    nextCursor: 'library-3',
  },
  'library-3': {
    media: libraryRows.slice(MANAGER_MEDIA_PAGE_SIZE * 2, MANAGER_MEDIA_PAGE_SIZE * 3),
    nextCursor: 'library-4',
  },
  'library-4': { media: libraryRows.slice(MANAGER_MEDIA_PAGE_SIZE * 3), nextCursor: null },
};

function galleryRows(rows: typeof libraryRows) {
  return rows.map((row) => ({
    id: row.id,
    originalFilename: row.originalFilename,
    guestName: row.guestName,
    caption: row.caption,
    publicationStatus: row.publicationStatus,
    previewAvailable: true,
    width: row.width,
    height: row.height,
    receivedAt: row.createdAt,
    timelineAt: row.createdAt,
    timelineSource: 'received' as const,
    isFavorite: false,
  }));
}

async function installViteRefreshGlobals(page: Page) {
  // The focused config deliberately uses Cloudflare's Vite dev server instead of the repo-wide
  // build. Its SPA fallback does not pass index.html through plugin-react's HTML transform, so
  // provide the inert refresh globals the transformed modules require; these tests do not exercise HMR.
  await page.addInitScript(() => {
    Object.assign(window, {
      $RefreshReg$: () => undefined,
      $RefreshSig$: () => (type: unknown) => type,
    });
  });
}

async function installHostAccountSession(page: Page) {
  await page.context().addCookies([
    {
      name: 'candidary_host',
      value: 'host-session.fixture-secret',
      url: e2eOrigin,
      httpOnly: true,
      sameSite: 'Lax',
    },
    {
      name: 'candidary_host_csrf',
      value: 'host-csrf-fixture',
      url: e2eOrigin,
      sameSite: 'Strict',
    },
  ]);
  await page.route('**/api/host/session', (route) => route.fulfill({
    headers: { 'cache-control': 'private, no-store' },
    json: {
      data: {
        account: { email: 'host@example.test' },
        events: [{ id: EVENT_FIXTURE.id }],
      },
      requestId: 'request-host-session',
    },
  }));
}

test('deep Library anchor survives Guest gallery and Back', async ({ page }) => {
  await installViteRefreshGlobals(page);
  await stubManagerRoutes(page, {
    mediaPages: libraryPages,
    event: { storedMediaCount: libraryRows.length },
  });

  const libraryGets: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET'
      && url.pathname === `/api/manage/events/${EVENT_FIXTURE.id}/gallery`) {
      libraryGets.push(url.href);
    }
  });
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/gallery**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/gallery/summary')) return route.fallback();
    const cursor = url.searchParams.get('cursor') ?? 'first';
    const fixture = libraryPages[cursor as keyof typeof libraryPages]
      ?? { media: [], nextCursor: null };
    return route.fulfill({
      json: {
        data: { media: galleryRows(fixture.media), nextCursor: fixture.nextCursor },
        requestId: 'request-gallery-anchor',
      },
    });
  });
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/media**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== `/api/manage/events/${EVENT_FIXTURE.id}/media`
      || !url.searchParams.has('status')) return route.fallback();
    return route.fulfill({
      json: {
        data: { media: guestRows, nextCursor: null },
        requestId: 'request-guest-gallery',
      },
    });
  });

  await page.goto(managerGalleryUrl);
  const libraryTiles = page.locator('.gallery-private [data-gallery-anchor-id]');
  const more = page.getByRole('button', { name: 'Load more photos' });
  await expect(more).toBeVisible();
  const initialRequestCount = libraryGets.length;
  for (const continuation of [1, 2, 3]) {
    await more.click();
    await expect.poll(() => libraryGets.length).toBe(initialRequestCount + continuation);
  }
  const showMore = page.getByRole('button', { name: 'Show more photos' });
  while (await showMore.count() > 0) {
    await showMore.first().click();
  }
  await expect(libraryTiles).toHaveCount(libraryRows.length);

  const tileId = libraryRows[80]!.id;
  const tile = page.locator(`[data-photo-id="${tileId}"]`);
  await tile.scrollIntoViewIfNeeded();
  await tile.evaluate((element) => {
    const navBottom = document.querySelector<HTMLElement>('.manager-nav')
      ?.getBoundingClientRect().bottom ?? 0;
    const effectiveTop = Math.max(0, navBottom);
    window.scrollBy({ top: element.getBoundingClientRect().top - effectiveTop - 80 });
  });
  const effectiveOffset = async () => tile.evaluate((element) => {
    const navBottom = document.querySelector<HTMLElement>('.manager-nav')
      ?.getBoundingClientRect().bottom ?? 0;
    return element.getBoundingClientRect().top - Math.max(0, navBottom);
  });
  const before = await effectiveOffset();
  const libraryGetsBeforeLeave = libraryGets.length;

  await page.getByRole('button', { name: 'Guest gallery' }).click();
  await expect(page.locator('.gallery-shared [data-gallery-anchor-id]')).toHaveCount(guestRows.length);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(effectiveOffset).toBeCloseTo(before, 0);
  expect(Math.abs((await effectiveOffset()) - before)).toBeLessThanOrEqual(1);
  expect(libraryGets).toHaveLength(libraryGetsBeforeLeave);
});

test('Share opens complete export', async ({ page }) => {
  await installViteRefreshGlobals(page);
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: makeMedia(1, 'unpublished'), nextCursor: null } },
    event: { storedMediaCount: 1 },
  });

  await page.goto(`/manage/event/${EVENT_FIXTURE.id}?section=share`);
  await page.locator('.manager-export-route').getByRole('button', { name: 'Open Gallery' }).click();

  await expect(page).toHaveURL(managerGalleryUrl);
  const action = page.getByRole('button', { name: 'Download all' });
  await expect(action).toBeFocused();
  await page.getByRole('button', { name: 'Guest gallery' }).focus();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Share your event' })).toBeVisible();
  await page.goForward();
  await expect(action).not.toBeFocused();
});

test('retained Album slot opens Recently deleted', async ({ page }) => {
  await installViteRefreshGlobals(page);
  const mediaId = '90000000-0000-4000-8000-000000000001';
  const restoreUntil = '2099-10-19T00:00:00.000Z';
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    event: { recoverableMediaCount: 1 },
  });
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/album`, (route) => route.fulfill({
    json: { data: { album: {
      revision: 1,
      saved: true,
      title: 'Album',
      description: '',
      coverMediaId: null,
      effectiveCoverMediaId: null,
      coverRetained: null,
      entries: [{
        kind: 'photo-retained',
        slot: { mediaId, restoreUntil, state: 'recoverable' },
      }],
      photoCount: 0,
      retainedCount: 1,
      sectionCount: 0,
      totalBytes: 0,
    } }, requestId: 'request-retained-album' },
  }));
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/media/trash`, (route) => route.fulfill({
    json: { data: { media: [{
      id: mediaId,
      originalFilename: 'retained-photo.jpg',
      guestName: 'Avery',
      caption: 'Held moment',
      trashedAt: '2026-09-20T01:00:00.000Z',
      restoreUntil,
    }], nextCursor: null }, requestId: 'request-retained-trash' },
  }));

  await page.goto(`/manage/event/${EVENT_FIXTURE.id}?section=gallery&mode=album`);
  await page.getByRole('button', { name: 'Restore in Recently deleted' }).click();

  await expect(page).toHaveURL(`/manage/event/${EVENT_FIXTURE.id}`);
  await expect(page.getByRole('button', { name: 'Restore retained-photo.jpg' })).toBeFocused();
});

test('Guest gallery Settings round trip restores Hidden and focus', async ({ page }) => {
  await installViteRefreshGlobals(page);
  const hiddenRows = makeMedia(1, 'hidden');
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: hiddenRows, nextCursor: null } },
    event: { galleryVisible: false },
    galleryAudienceSummary: {
      albumPhotoCount: 0,
      albumEntryCount: 0,
      albumLink: { active: false, sharedAt: null },
      guestGalleryVisible: false,
      guestGalleryPublishedCount: 0,
    },
  });
  let releaseSettings!: () => void;
  const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve; });
  let markSettingsStarted!: () => void;
  const settingsStarted = new Promise<void>((resolve) => { markSettingsStarted = resolve; });
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/settings`, async (route) => {
    markSettingsStarted();
    await settingsGate;
    await route.fulfill({
      json: {
        data: {
          event: {
            ...EVENT_FIXTURE,
            galleryVisible: false,
            ...route.request().postDataJSON() as Partial<typeof EVENT_FIXTURE>,
          },
        },
        requestId: 'request-settings-return',
      },
    });
  });

  await page.goto(`/manage/event/${EVENT_FIXTURE.id}?section=gallery&mode=guest-gallery`);
  const filters = page.getByRole('group', { name: 'Publication status' });
  await filters.getByRole('button', { name: 'Hidden' }).click();
  await page.getByRole('checkbox', { name: /Select /u }).click();
  await page.getByRole('button', { name: 'Open settings' }).click();

  const availability = page.getByLabel('Show the optional shared gallery');
  await expect(availability).toBeFocused();
  const returnAction = page.getByRole('button', { name: 'Return to Guest gallery' });
  await expect(returnAction).toBeVisible();

  await page.getByLabel('Review guestbook notes before sharing').click();
  await settingsStarted;
  await returnAction.click();

  await expect(page).toHaveURL(`/manage/event/${EVENT_FIXTURE.id}?section=settings`);
  await expect(returnAction).toBeVisible();
  releaseSettings();

  await expect(page).toHaveURL(
    `/manage/event/${EVENT_FIXTURE.id}?section=gallery&mode=guest-gallery`,
  );
  await expect(filters.getByRole('button', { name: 'Hidden' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeFocused();
  await expect(page.getByText('Selection cleared.')).toBeAttached();
});

test('rotation save gate refuses Back and reload until Copy releases account-session navigation', async ({ page }) => {
  await installViteRefreshGlobals(page);
  await installHostAccountSession(page);
  await page.context().grantPermissions(
    ['clipboard-read', 'clipboard-write'],
    { origin: e2eOrigin },
  );
  const fixture = await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    event: {
      managerLinkRevision: 4,
      managerLinkRotationAvailability: { enabled: true, reason: null },
    },
    managerLinkRotation: { managementLink: rotatedManagementLink },
  });
  const mainFrameNavigations: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations.push(frame.url());
  });

  await page.goto('/privacy');
  await page.goto(managerSettingsUrl);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Rotate manager link' });
  await trigger.focus();
  await page.keyboard.press('Enter');

  const confirmation = page.getByRole('dialog', { name: 'Rotate management link?' });
  const keep = confirmation.getByRole('button', { name: 'Keep current link' });
  await expect(keep).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirmation.getByRole('button', { name: 'Rotate link' })).toBeFocused();
  await page.keyboard.press('Enter');

  const result = page.getByRole('dialog', { name: 'Save your new management link' });
  const copy = result.getByRole('button', { name: 'Copy management link' });
  await expect(copy).toBeFocused();
  await expect(result.getByRole('button', { name: 'Continue managing' })).toBeDisabled();

  const blockedBack = page.goBack();
  await expect(page).toHaveURL(managerSettingsUrl);
  await expect(result).toBeVisible();
  await blockedBack;

  const dialogPromise = page.waitForEvent('dialog');
  const reloadAttempt = page.reload().catch(() => null);
  const beforeUnload = await dialogPromise;
  expect(beforeUnload.type()).toBe('beforeunload');
  await beforeUnload.dismiss();
  await reloadAttempt;
  await expect(page).toHaveURL(managerSettingsUrl);
  await expect(result).toBeVisible();
  await expect(copy).toBeFocused();
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);

  await page.keyboard.press('Enter');
  await expect(result.getByRole('button', { name: 'Continue managing' })).toBeEnabled();
  await expect(result.getByRole('button', { name: 'Continue managing' })).toBeFocused();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(rotatedManagementLink);
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(false);

  await page.goBack();
  await expect(page).toHaveURL('/privacy');
  expect(mainFrameNavigations.some((url) => url.includes('replacement-id.replacement-secret')))
    .toBe(false);
  expect(fixture.managerLinkRotation.requests).toHaveLength(1);
  const [request] = fixture.managerLinkRotation.requests;
  expect(request).toMatchObject({
    body: { expectedManagerLinkRevision: 4 },
    responseStatus: 200,
  });
  expect(request!.headers.cookie).toContain('candidary_host=host-session.fixture-secret');
  expect(request!.headers['x-candidary-host-csrf']).toBe('host-csrf-fixture');
  expect(request!.headers['x-candidary-csrf']).toBeUndefined();
});

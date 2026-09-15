import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import type {
  PhotoExportCapabilities,
  PhotoExportEntryView,
  PhotoExportSource,
  PhotoExportView,
} from '../../shared/photo-exports';
import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';
import {
  measureDocument,
  measureTarget,
  measureViewportEscapes,
} from './helpers/geometry';
import { settleRendering } from './helpers/rendering';

const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;
const routeBase = `/api/manage/events/${EVENT_FIXTURE.id}/photo-exports`;
const frozenAt = '2026-09-12T20:00:00.000Z';
const holdExpiresAt = '2026-09-13T20:00:00.000Z';
const absoluteExpiresAt = '2026-09-14T20:00:00.000Z';

interface PhotoRouteAudit {
  creates: Array<{ source: PhotoExportSource; destination: 'archive' | 'device' }>;
  handoffs: string[][];
  originalReads: string[];
}

interface ShareAttempt {
  name: string;
  type: string;
  size: number;
  bytes: number[];
}

const originalKinds = [
  { filename: 'garden.jpeg', mimeType: 'image/jpeg', bytes: [255, 216, 255, 224] },
  { filename: 'portrait.png', mimeType: 'image/png', bytes: [137, 80, 78, 71] },
  { filename: 'toast.webp', mimeType: 'image/webp', bytes: [82, 73, 70, 70] },
  { filename: 'arrival.heic', mimeType: 'image/heic', bytes: [0, 0, 0, 24] },
  { filename: 'dance.heif', mimeType: 'image/heif', bytes: [102, 116, 121, 112] },
] as const;

function frozenEntries(count = 22) {
  return makeMedia(count).map((media, index) => {
    const kind = originalKinds[index] ?? {
      filename: `original-${index + 1}.jpg`,
      mimeType: 'image/jpeg',
      bytes: [index + 1, index + 2, index + 3],
    };
    return {
      view: {
        mediaId: media.id,
        position: index,
        filename: kind.filename,
        mimeType: kind.mimeType,
        byteSize: kind.bytes.length,
        state: 'pending',
      } satisfies PhotoExportEntryView,
      bytes: [...kind.bytes],
    };
  });
}

function envelope<T>(data: T) {
  return { data, requestId: 'photo-export-e2e' };
}

async function stubPhotoExportRoutes(
  page: Page,
  { enabled = true, failMediaId }: { enabled?: boolean; failMediaId?: string } = {},
) {
  const entries = frozenEntries();
  const audit: PhotoRouteAudit = { creates: [], handoffs: [], originalReads: [] };
  const acknowledged = new Set<string>();
  let failed = new Set<string>();
  let job: PhotoExportView | null = null;
  let jobSequence = 0;

  const activeJob = (): PhotoExportCapabilities['activeJob'] => {
    if (!job || ['ready', 'failed', 'expired', 'cancelled', 'handed-off', 'delivered'].includes(job.state)) {
      return null;
    }
    return {
      id: job.id,
      kind: 'selection',
      state: job.state,
      destination: job.destination,
      mediaCount: job.mediaCount,
      totalBytes: job.totalBytes,
      ownedByCurrentPrincipal: true,
    };
  };

  await page.route(`**${routeBase}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === `${routeBase}/capabilities` && method === 'GET') {
      await route.fulfill({
        json: envelope<PhotoExportCapabilities>({
          enabled,
          destinations: enabled ? ['archive', 'device'] : [],
          activeJob: activeJob(),
        }),
      });
      return;
    }

    if (path === routeBase && method === 'POST') {
      const requestBody = request.postDataJSON() as {
        source: PhotoExportSource;
        destination: 'archive' | 'device';
      };
      audit.creates.push({ source: requestBody.source, destination: requestBody.destination });
      acknowledged.clear();
      failed = new Set();
      jobSequence += 1;
      job = {
        id: `photo-export-e2e-${jobSequence}`,
        kind: 'selection',
        destination: requestBody.destination,
        source: requestBody.source,
        state: 'queued',
        snapshotAt: frozenAt,
        createdAt: frozenAt,
        confirmedAt: null,
        completedAt: null,
        mediaCount: entries.length,
        totalBytes: entries.reduce((sum, entry) => sum + entry.view.byteSize, 0),
        handedOffCount: 0,
        unavailableCount: 0,
        holdExpiresAt,
        absoluteExpiresAt,
        cancelRequested: false,
        errorCode: null,
        attempt: 1,
      };
      await route.fulfill({ status: 202, json: envelope({ export: job }) });
      return;
    }

    if (!job || !path.startsWith(`${routeBase}/${job.id}`)) {
      await route.fulfill({
        status: 404,
        json: { code: 'EXPORT_NOT_FOUND', message: 'Export not found.', requestId: 'photo-export-e2e' },
      });
      return;
    }

    if (path === `${routeBase}/${job.id}` && method === 'GET') {
      await route.fulfill({ json: envelope({ export: job }) });
      return;
    }

    if (path === `${routeBase}/${job.id}/entries` && method === 'GET') {
      expect(url.searchParams.get('after')).toBe('0');
      expect(url.searchParams.get('limit')).toBe('100');
      await route.fulfill({
        json: envelope({
          entries: entries.map(({ view }) => ({
            ...view,
            state: acknowledged.has(view.mediaId)
              ? 'acknowledged' as const
              : failed.has(view.mediaId) ? 'failed' as const : 'pending' as const,
          })),
          nextPosition: null,
        }),
      });
      return;
    }

    const fileMatch = path.match(new RegExp(`^${routeBase}/${job.id}/entries/([^/]+)/file$`, 'u'));
    if (fileMatch && method === 'GET') {
      const mediaId = decodeURIComponent(fileMatch[1]!);
      const entry = entries.find(({ view }) => view.mediaId === mediaId);
      audit.originalReads.push(mediaId);
      if (!entry) {
        await route.fulfill({
          status: 404,
          json: { code: 'MEDIA_NOT_FOUND', message: 'Photo not found.', requestId: 'photo-export-e2e' },
        });
        return;
      }
      if (mediaId === failMediaId) {
        failed.add(mediaId);
        job = { ...job, unavailableCount: failed.size };
        await route.fulfill({
          status: 503,
          json: { code: 'MEDIA_NOT_READY', message: 'Original temporarily unavailable.', requestId: 'photo-export-e2e' },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': entry.view.mimeType, 'cache-control': 'private, no-store' },
        body: Buffer.from(entry.bytes),
      });
      return;
    }

    if (path === `${routeBase}/${job.id}/confirm` && method === 'POST') {
      job = { ...job, state: 'running', confirmedAt: frozenAt };
      await route.fulfill({ json: envelope({ export: job }) });
      return;
    }

    if (path === `${routeBase}/${job.id}/handoff` && method === 'POST') {
      const mediaIds = (request.postDataJSON() as { mediaIds: string[] }).mediaIds;
      audit.handoffs.push([...mediaIds]);
      mediaIds.forEach((mediaId) => acknowledged.add(mediaId));
      const terminal = acknowledged.size >= entries.length;
      job = {
        ...job,
        state: terminal ? 'handed-off' : 'running',
        handedOffCount: acknowledged.size,
        unavailableCount: failed.size,
        completedAt: terminal ? frozenAt : null,
      };
      await route.fulfill({ json: envelope({ export: job }) });
      return;
    }

    if (path === `${routeBase}/${job.id}/cancel` && method === 'POST') {
      job = { ...job, state: 'cancelled', cancelRequested: true, completedAt: frozenAt };
      await route.fulfill({ json: envelope({ export: job }) });
      return;
    }

    await route.fulfill({
      status: 404,
      json: { code: 'EXPORT_NOT_FOUND', message: 'Export action not found.', requestId: 'photo-export-e2e' },
    });
  });

  return { audit, entries };
}

async function installNativeShareStub(page: Page) {
  await page.addInitScript(() => {
    const state = {
      cancelNext: true,
      canShareCalls: 0,
      attempts: [] as File[][],
    };
    (window as unknown as { __photoShareAudit: typeof state }).__photoShareAudit = state;
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: (data: ShareData) => {
        state.canShareCalls += 1;
        return Array.isArray(data.files) && data.files.length > 0;
      },
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data: ShareData) => {
        state.attempts.push([...(data.files ?? [])]);
        if (state.cancelNext) {
          state.cancelNext = false;
          return Promise.reject(new DOMException('Cancelled by the host.', 'AbortError'));
        }
        return Promise.resolve();
      },
    });
  });
}

async function readShareAttempts(page: Page): Promise<ShareAttempt[][]> {
  return page.evaluate(async () => {
    const state = (window as unknown as {
      __photoShareAudit: { attempts: File[][] };
    }).__photoShareAudit;
    return Promise.all(state.attempts.map(async (files) => Promise.all(files.map(async (file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    })))));
  });
}

async function openGallery(page: Page) {
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await page.locator('.manager-nav nav button').filter({ hasText: 'Gallery' }).click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
}

async function expectNoOverflow(page: Page, state: string) {
  const size = await measureDocument(page);
  expect(size.scrollWidth, `${state} horizontal overflow`).toBeLessThanOrEqual(size.clientWidth + 1);
  expect(await measureViewportEscapes(page.locator('main')), `${state} viewport escapes`).toEqual([]);
}

async function expectTargetsAtLeast44(locator: Locator, state: string) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const target = locator.nth(index);
    if (!await target.isVisible()) continue;
    const size = await measureTarget(target);
    expect(size.width, `${state} target ${index + 1} width`).toBeGreaterThanOrEqual(44);
    expect(size.height, `${state} target ${index + 1} height`).toBeGreaterThanOrEqual(44);
  }
}

async function centerClick(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  await locator.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
}

async function exposeActionBetweenChrome(page: Page, locator: Locator, state: string) {
  await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const topObstruction = [...document.querySelectorAll<HTMLElement>('.manager-nav, .gallery-control-row')]
      .map((candidate) => ({ rect: candidate.getBoundingClientRect(), position: getComputedStyle(candidate).position }))
      .filter(({ rect: candidate, position }) => (position === 'fixed' || position === 'sticky')
        && candidate.left < rect.right && rect.left < candidate.right)
      .reduce((bottom, { rect: candidate }) => Math.max(bottom, candidate.bottom), 0);
    const safeTop = topObstruction + 8;
    window.scrollBy(0, rect.top - safeTop);
  });
  await expect.poll(async () => {
    const [box, obstructions] = await Promise.all([
      locator.boundingBox(),
      page.evaluate(() => ({
        tops: [...document.querySelectorAll<HTMLElement>('.manager-nav, .gallery-control-row')]
          .map((candidate) => ({ rect: candidate.getBoundingClientRect().toJSON(), position: getComputedStyle(candidate).position })),
        trayTop: document.querySelector<HTMLElement>('.selection-tray')?.getBoundingClientRect().top ?? innerHeight,
      })),
    ]);
    const topObstruction = box === null ? 0 : obstructions.tops
      .filter(({ rect, position }) => (position === 'fixed' || position === 'sticky')
        && rect.left < box.x + box.width && box.x < rect.right)
      .reduce((bottom, { rect }) => Math.max(bottom, rect.bottom), 0);
    return box !== null
      && box.y >= topObstruction + 7
      && box.y + box.height <= obstructions.trayTop - 7;
  }, { message: `${state} must fit between sticky navigation and the selection tray` }).toBe(true);
}

async function exposedCenter(locator: Locator, state: string) {
  const hitTest = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const hit = document.elementFromPoint(center.x, center.y);
    return {
      center,
      relativeCenter: { x: rect.width / 2, y: rect.height / 2 },
      ownsCenter: hit === element || (hit !== null && element.contains(hit)),
      hit: hit instanceof HTMLElement ? `${hit.tagName.toLowerCase()}.${hit.className}` : String(hit),
      target: rect.toJSON(),
    };
  });
  expect(hitTest.ownsCenter, `${state} center hit target; ${JSON.stringify(hitTest)}`).toBe(true);
  return hitTest;
}

async function clickExposedCenter(locator: Locator, state: string) {
  const hitTest = await exposedCenter(locator, state);
  await locator.click({ position: hitTest.relativeCenter });
}

async function exposeChooserDestinations(page: Page, chooser: Locator, state: string) {
  const heading = chooser.getByRole('heading', { name: /^(Save \/ Share photos|Save Album photos)$/u });
  const first = chooser.getByRole('button', { name: 'Prepare for this device' });
  const last = chooser.getByRole('button', { name: 'Prepare photo ZIP' });
  await exposeActionBetweenChrome(page, heading, `${state} heading`);
  await expect.poll(async () => {
    const [firstBox, lastBox, trayTop] = await Promise.all([
      first.boundingBox(),
      last.boundingBox(),
      page.locator('.selection-tray').evaluate((tray) => tray.getBoundingClientRect().top),
    ]);
    return firstBox !== null && lastBox !== null
      && firstBox.y >= 0
      && lastBox.y + lastBox.height <= trayTop - 7;
  }, { message: `${state} destination choices must be visibly reachable above the selection tray` }).toBe(true);
  await exposedCenter(first, `${state} device destination`);
  await exposedCenter(last, `${state} ZIP destination`);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await settleRendering(page, { parkPointer: true });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
}

const viewportCases = [
  { label: 'phone-320', project: 'mobile', viewport: { width: 320, height: 568 } },
  { label: 'phone-390', project: 'mobile', viewport: { width: 390, height: 844 } },
  { label: 'desktop-1440', project: 'desktop', viewport: { width: 1440, height: 1000 } },
] as const;

for (const viewportCase of viewportCases) {
  test(`${viewportCase.label} keeps Library and Album whole-tile selection contained and focus-safe`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== viewportCase.project, `covered by ${viewportCase.project}`);
    await page.setViewportSize(viewportCase.viewport);
    const loaded = makeMedia(3);
    await stubManagerRoutes(page, {
      mediaPages: { first: { media: loaded, nextCursor: 'unloaded-page' } },
      event: { storedMediaCount: 22, storedBytes: 88 },
      album: { pickedMediaIds: loaded.map(({ id }) => id) },
    });
    const photoRoutes = await stubPhotoExportRoutes(page);
    await openGallery(page);

    await page.getByRole('button', { name: 'Select photos' }).click();
    const libraryTile = page.locator(`[data-photo-id="${loaded[0]!.id}"] .gallery-mosaic__select`);
    await centerClick(libraryTile);
    await expect(libraryTile).toHaveAttribute('aria-pressed', 'true');
    await libraryTile.press('Space');
    await expect(libraryTile).toHaveAttribute('aria-pressed', 'false');
    await libraryTile.press('Enter');
    await expect(libraryTile).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const libraryAction = page.getByRole('region', { name: 'Album' })
      .getByRole('button', { name: 'Save / Share photos' });
    await libraryAction.click();
    const completeCard = page.getByRole('region', { name: 'Complete export' });
    const libraryChooser = completeCard.getByRole('region', { name: 'Save or share photos' });
    await expect(libraryChooser).toBeVisible();
    await expect(page.getByRole('region', { name: 'Save or share photos' })).toHaveCount(1);
    await expect(libraryChooser.getByRole('heading', { name: 'Save / Share photos' })).toBeFocused();
    await expectTargetsAtLeast44(libraryChooser.getByRole('button'), `${viewportCase.label} Library chooser`);
    await expectNoOverflow(page, `${viewportCase.label} Library chooser`);
    if (viewportCase.label === 'phone-390') {
      await exposeChooserDestinations(page, libraryChooser, 'phone-390 Library chooser');
      await capture(page, testInfo, 'phone-390-library-chooser-in-complete-card');
    }
    const closeLibraryChooser = libraryChooser.getByRole('button', { name: 'Close photo export' });
    await exposeActionBetweenChrome(page, closeLibraryChooser, `${viewportCase.label} Close photo export`);
    await clickExposedCenter(closeLibraryChooser, `${viewportCase.label} Close photo export`);
    await expect(libraryAction).toBeFocused();

    const modes = page.getByRole('group', { name: 'Gallery mode' });
    await modes.getByRole('button', { name: /^Album, 3$/u }).click();
    await expect(page.getByRole('heading', { name: 'Album', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Select Album photos' }).click();
    const albumTile = page.locator('.album-review-grid__photo').first().locator('.album-photo-select');
    await centerClick(albumTile);
    await expect(albumTile).toHaveAttribute('aria-pressed', 'true');
    await albumTile.press('Space');
    await expect(albumTile).toHaveAttribute('aria-pressed', 'false');
    await albumTile.press('Enter');
    await expect(albumTile).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (viewportCase.label === 'phone-320') {
      await albumTile.scrollIntoViewIfNeeded();
      await capture(page, testInfo, 'phone-320-album-select-mode');
    }

    await page.getByRole('button', { name: 'Select all Album photos' }).click();
    const albumAction = page.getByRole('region', { name: 'Album photo selection' })
      .getByRole('button', { name: 'Save / Share photos' });
    await albumAction.click();
    const albumCard = page.locator('.album-export');
    const albumChooser = albumCard.getByRole('region', { name: 'Save or share photos' });
    await expect(albumChooser).toBeVisible();
    await expect(page.getByRole('region', { name: 'Save or share photos' })).toHaveCount(1);
    await albumChooser.getByRole('button', { name: 'Close photo export' }).click();
    await expect(albumAction).toBeFocused();

    await albumAction.click();
    await albumChooser.getByRole('button', { name: 'Prepare photo ZIP' }).click();
    await expect(albumChooser).toContainText('22 photos');
    await expect(page.locator('.album-review-grid__photo')).toHaveCount(3);
    expect(photoRoutes.audit.creates.at(-1)).toEqual({
      destination: 'archive',
      source: { mode: 'all', scope: 'album', excludedMediaIds: [] },
    });
    await expectTargetsAtLeast44(albumChooser.getByRole('button'), `${viewportCase.label} Album chooser`);
    await expectNoOverflow(page, `${viewportCase.label} Album chooser`);
  });
}

test('native handoff receives the exact private Files, keeps a cancelled batch, and advances Select all in batches', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'native boundary is covered once in the mobile project');
  await page.setViewportSize({ width: 390, height: 844 });
  await installNativeShareStub(page);
  const loaded = makeMedia(3);
  const fixtureEntries = frozenEntries();
  const failedMediaId = fixtureEntries[5]!.view.mediaId;
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: loaded, nextCursor: 'unloaded-page' } },
    event: { storedMediaCount: fixtureEntries.length, storedBytes: 88 },
    album: { pickedMediaIds: loaded.map(({ id }) => id) },
  });
  const photoRoutes = await stubPhotoExportRoutes(page, { failMediaId: failedMediaId });
  await openGallery(page);

  await page.getByRole('button', { name: 'Select photos' }).click();
  await page.getByRole('button', { name: 'Select all matching photos' }).click();
  const selectAllAction = page.getByRole('region', { name: 'Album' })
    .getByRole('button', { name: 'Save / Share photos' });
  await selectAllAction.click();
  const chooser = page.getByRole('region', { name: 'Save or share photos' });
  await expect(chooser.getByRole('button', { name: 'Prepare photo ZIP' })).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Prepare full archive' })).toBeVisible();

  await chooser.getByRole('button', { name: 'Prepare for this device' }).click();
  await expect(chooser).toContainText('22 photos');
  expect(photoRoutes.audit.creates).toEqual([{
    destination: 'device',
    source: { mode: 'all', scope: 'library', filter: { order: 'newest' }, excludedMediaIds: [] },
  }]);
  expect(await page.evaluate(() => (
    window as unknown as { __photoShareAudit: { attempts: File[][] } }
  ).__photoShareAudit.attempts.length)).toBe(0);

  await chooser.getByRole('button', { name: 'Confirm and prepare photos' }).click();
  await expect(chooser.getByRole('button', { name: 'Share 19 photos' })).toBeVisible();
  await expect(chooser).toContainText('Unavailable: 1');
  expect(photoRoutes.audit.originalReads).toHaveLength(20);
  expect(await page.evaluate(() => (
    window as unknown as { __photoShareAudit: { attempts: File[][] } }
  ).__photoShareAudit.attempts.length)).toBe(0);

  await chooser.getByRole('button', { name: 'Share 19 photos' }).click();
  await expect(chooser.getByRole('alert')).toContainText('Sharing was cancelled. Your prepared photos are still here.');
  await expect(chooser.getByRole('button', { name: 'Share 19 photos' })).toBeVisible();
  expect(photoRoutes.audit.handoffs).toHaveLength(0);

  const cancelledAttempt = (await readShareAttempts(page))[0]!;
  expect(cancelledAttempt.slice(0, 5)).toEqual(originalKinds.map((entry) => ({
    name: entry.filename,
    type: entry.mimeType,
    size: entry.bytes.length,
    bytes: [...entry.bytes],
  })));

  await chooser.getByRole('button', { name: 'Share 19 photos' }).click();
  await expect(chooser).toContainText('Handed to your device: 19');
  await expect(chooser.getByRole('button', { name: 'Prepare next photos' })).toBeVisible();
  expect(photoRoutes.audit.handoffs[0]).toHaveLength(19);

  await chooser.getByRole('button', { name: 'Prepare next photos' }).click();
  await expect(chooser.getByRole('button', { name: 'Share 2 photos' })).toBeVisible();
  expect(photoRoutes.audit.originalReads).toHaveLength(22);
  await chooser.getByRole('button', { name: 'Share 2 photos' }).click();
  await expect(chooser).toContainText('Handed to your device: 21');
  await expect(chooser).toContainText('Unavailable: 1');
  await expect(chooser.getByRole('button', { name: 'Use ZIP instead' })).toBeVisible();
  await expect(chooser).not.toContainText('For another copy, close this receipt and start a new photo export.');
  expect(photoRoutes.audit.handoffs[1]).toHaveLength(2);
  expect(photoRoutes.audit.creates).toHaveLength(1);

  const attempts = await readShareAttempts(page);
  expect(attempts).toHaveLength(3);
  expect(attempts[1]).toEqual(cancelledAttempt);
  expect(attempts[2]!.map(({ name, type, size }) => ({ name, type, size }))).toEqual([
    { name: 'original-21.jpg', type: 'image/jpeg', size: 3 },
    { name: 'original-22.jpg', type: 'image/jpeg', size: 3 },
  ]);
  await expectNoOverflow(page, 'completed device receipt');
});

test('disabled selection capability preserves complete and Album legacy archives without another chooser', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'legacy archive fallback is covered once in the desktop project');
  const loaded = makeMedia(3);
  const legacy = await stubManagerRoutes(page, {
    mediaPages: { first: { media: loaded, nextCursor: null } },
    event: { storedMediaCount: loaded.length, storedBytes: 384 },
    album: { pickedMediaIds: loaded.map(({ id }) => id) },
  });
  await stubPhotoExportRoutes(page, { enabled: false });
  await openGallery(page);

  const completeCard = page.getByRole('region', { name: 'Complete export' });
  await expect(page.getByRole('button', { name: 'Save / Share photos' })).toBeDisabled();
  await expect(completeCard).toContainText('New photo exports are paused.');
  const completeLegacy = page.getByRole('button', { name: 'Download all' });
  await expect(completeLegacy).toBeEnabled();
  await completeLegacy.click();
  const legacyCreates = () => legacy.album.requests.filter(({ method, path }) => (
    method === 'POST' && path.endsWith('/exports')
  ));
  await expect.poll(() => legacyCreates().length).toBe(1);
  expect(legacyCreates()[0]?.body).toEqual({});

  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Album, 3$/u }).click();
  const albumCard = page.locator('.album-export');
  await expect(albumCard.getByRole('button', { name: 'Save / Share photos' })).toHaveCount(0);
  await expect(albumCard).not.toContainText('New photo exports are paused.');
  await expect(albumCard).toContainText('Current Album: 3 photos.');
  const albumLegacy = albumCard.getByRole('button', { name: 'Prepare Album ZIP' });
  await expect(albumLegacy).toBeDisabled();

  await page.evaluate(async (endpoint) => {
    await fetch(endpoint);
    await fetch(endpoint);
    await fetch(endpoint);
  }, `/api/manage/events/${EVENT_FIXTURE.id}/exports`);
  await openGallery(page);
  await expect(page.getByRole('region', { name: 'Complete export' })).toContainText('Ready');
  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Album, 3$/u }).click();
  const readyAlbumLegacy = page.locator('.album-export')
    .getByRole('button', { name: 'Prepare Album ZIP' });
  await expect(readyAlbumLegacy).toBeEnabled();
  await readyAlbumLegacy.click();
  await expect.poll(() => legacyCreates().length).toBe(2);
  expect(legacyCreates().at(-1)?.body).toEqual({ kind: 'album' });
  await expect(page.getByRole('region', { name: 'Save or share photos' })).toHaveCount(0);
  await expectNoOverflow(page, 'disabled selection legacy archives');
});

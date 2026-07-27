import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { EVENT_FIXTURE, stubGuestRoutes, stubManagerRoutes } from './fixtures/routes';
import { LONG_FILENAME, makeMedia } from './fixtures/ui-data';
import { measureContrast, measureDocument, measureTarget } from './helpers/geometry';

// The design system holds hint and caption text inside this band.
const CAPTION_TEXT_RANGE = { min: 12, max: 14 };

const GUEST_EVENT = `**/api/event/${EVENT_FIXTURE.slug}`;
// The fixture answers the event detail through this exact pattern, so an override has to use it too.
const MANAGER_EVENT = new RegExp(`/api/manage/events/${EVENT_FIXTURE.id}$`, 'u');

const OFFLINE = {
  code: 'INTERNAL_ERROR',
  message: 'Something went wrong. Try again and keep this request ID if the problem continues.',
};
const RETRY_HINT = 'This did not go through. Try again in a moment.';
const GUEST_LINK_HINT = 'Open the latest guest link from your host to start again.';
const MANAGER_LINK_HINT = 'Open the latest management link you saved to start again.';
const GUEST_LIFECYCLE_HINT = 'Your host can share a new link if you still need to send photos.';
const MANAGER_LIFECYCLE_HINT = 'Check the management link you saved. A closed or deleted event cannot be reopened from here.';

// Retrying cannot mint a session, so every one of these has to recover through a link rather than a
// button whose every press repeats the same refusal.
const LINK_FAILURES = [
  { code: 'SESSION_REQUIRED', status: 401, message: 'Open your event link again to continue.' },
  { code: 'SESSION_EXPIRED', status: 401, message: 'This session has expired.' },
  { code: 'TOKEN_REVOKED', status: 403, message: 'This link was replaced with a new one.' },
  { code: 'ROLE_FORBIDDEN', status: 403, message: 'This link does not open that view.' },
];

// The normal end of every event, not an exotic case: the access window closes, the host deletes the
// event, or retention purges it. The messages are the ones `worker/auth/service.ts` actually sends.
const LIFECYCLE_FAILURES = [
  { code: 'EVENT_NOT_FOUND', status: 404, message: 'This event could not be found.' },
  { code: 'EVENT_DELETED', status: 410, message: 'This event has been deleted.' },
  { code: 'EVENT_EXPIRED', status: 410, message: 'This event access has expired.' },
];

// Two families, one rule: nothing a retry could answer, so each carries the guidance that does recover
// it — the link for a session failure, the event's own end for a lifecycle one.
function terminalFailures(linkHint: string, lifecycleHint: string) {
  return [
    ...LINK_FAILURES.map((failure) => ({ ...failure, hint: linkHint })),
    ...LIFECYCLE_FAILURES.map((failure) => ({ ...failure, hint: lifecycleHint })),
  ];
}

// Playwright consults route handlers newest first, so this sits in front of the fixture's own handler
// and hands every attempt after the first back to it.
async function failFirstAttempt(page: Page, url: string | RegExp, failure: typeof OFFLINE, status: number) {
  let attempts = 0;
  await page.route(url, (route: Route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ status, json: { ...failure, requestId: 'request-a' } })
      : route.fallback();
  });
}

// The live region has to carry the way out, not only the failure. On a state that offers no button
// the hint is the sole path forward, and a region announcing just the failure never mentions it.
async function expectAnnounced(page: Page, message: string, recoveryHint: string) {
  const alert = page.getByRole('alert');
  await expect(alert, 'the alert announces the failure').toContainText(message);
  await expect(alert, 'the alert announces the way out of it').toContainText(recoveryHint);
}

async function expectContained(page: Page) {
  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
}

async function expectMobileTarget(page: Page, name: string) {
  const target = await measureTarget(page.getByRole('button', { name, exact: true }));
  expect(target.width, `${name} target width`).toBeGreaterThanOrEqual(44);
  expect(target.height, `${name} target height`).toBeGreaterThanOrEqual(44);
}

// The narrowest supported phone and the tablet side of the band, then back to the project's own size.
async function expectRecoveryCardHolds(page: Page) {
  const viewport = page.viewportSize();
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await expectMobileTarget(page, 'Try again');
    await expectContained(page);
  }
  if (viewport) await page.setViewportSize(viewport);
}

test('a failed guest load recovers on the next attempt rather than dead-ending', async ({ page }) => {
  await stubGuestRoutes(page);
  await failFirstAttempt(page, GUEST_EVENT, OFFLINE, 500);
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);

  await expectAnnounced(page, OFFLINE.message, RETRY_HINT);
  const hint = page.getByText(RETRY_HINT);
  await expect(hint).toBeVisible();
  // The way out has to be legible: measured from the colours the browser actually resolved.
  expect(await measureContrast(hint), 'recovery hint contrast').toBeGreaterThanOrEqual(4.5);
  const hintSize = await hint.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(hintSize, 'recovery hint text size').toBeGreaterThanOrEqual(CAPTION_TEXT_RANGE.min);
  expect(hintSize, 'recovery hint text size').toBeLessThanOrEqual(CAPTION_TEXT_RANGE.max);

  await expectMobileTarget(page, 'Try again');
  await expectContained(page);
  await expectRecoveryCardHolds(page);

  await page.getByRole('button', { name: 'Try again', exact: true }).click();

  // Recovery means the guest reaches the photo drop, not merely that a button existed.
  await expect(page.getByRole('heading', { name: EVENT_FIXTURE.welcomeMessage })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take a photo', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expectContained(page);
});

test('a failed manager load recovers on the next attempt rather than dead-ending', async ({ page }) => {
  await stubManagerRoutes(page, { mediaPages: { first: { media: makeMedia(1), nextCursor: null } } });
  await failFirstAttempt(page, MANAGER_EVENT, OFFLINE, 500);
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);

  await expectAnnounced(page, OFFLINE.message, RETRY_HINT);
  await expect(page.getByText(RETRY_HINT)).toBeVisible();
  await expectMobileTarget(page, 'Try again');
  await expectContained(page);
  await expectRecoveryCardHolds(page);

  await page.getByRole('button', { name: 'Try again', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await expect(page.getByRole('heading', { name: EVENT_FIXTURE.name })).toBeVisible();
  await expect(page.locator('.moderation-grid article')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expectContained(page);
});

test('a guest failure no retry could answer points at what does recover it, and offers none', async ({ page }) => {
  const cases = terminalFailures(GUEST_LINK_HINT, GUEST_LIFECYCLE_HINT);
  let failure = cases[0]!;
  await stubGuestRoutes(page);
  await page.route(GUEST_EVENT, (route) => route.fulfill({
    status: failure.status,
    json: { code: failure.code, message: failure.message, requestId: 'request-a' },
  }));

  for (const terminal of cases) {
    failure = terminal;
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);

    await expect(page.getByRole('alert'), terminal.code).toContainText(terminal.message);
    await expect(page.getByText(terminal.hint), terminal.code).toBeVisible();
    await expectAnnounced(page, terminal.message, terminal.hint);
    // A retry here could only repeat the refusal, so the state must not offer one at all — and the
    // hint must never be the transport line, which would blame a connection that is working fine.
    await expect(page.getByRole('button', { name: 'Try again', exact: true }), terminal.code)
      .toHaveCount(0);
    await expect(page.getByText(RETRY_HINT), terminal.code).toHaveCount(0);
    await expectContained(page);
  }
});

// A rejected write is the ordinary case a host meets on reception wifi. The photos, the section, the
// filter, and the selection are all still true — only the write failed — so the view has to survive it.
const MUTATION_REFUSED = {
  code: 'MEDIA_STATE_CONFLICT',
  message: 'That photo changed before this update. Reload and try again.',
};
const MANAGER_BASE = `**/api/manage/events/${EVENT_FIXTURE.id}`;

async function openGallery(page: Page) {
  await stubManagerRoutes(page, {
    // Unpublished is the Gallery's own default filter and carries every card control at once.
    mediaPages: { first: { media: makeMedia(2, 'unpublished'), nextCursor: null } },
    event: { storedMediaCount: 2 },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await page.locator('.manager-nav nav button').filter({ hasText: 'Gallery' }).click();
  await expect(page.getByRole('heading', { name: 'Gallery publishing' })).toBeVisible();
  await expect(page.locator('.moderation-grid article')).toHaveCount(2);
}

// The notice has to be readable, dismissible by thumb, and contained — and everything it interrupted
// has to still be there underneath it.
async function expectRecoverableNotice(page: Page, survivingHeading: string) {
  const notice = page.getByRole('alert');
  await expect(notice).toContainText(MUTATION_REFUSED.message);
  // The notice is caption-weight prose, so it lives in the design system's 12–14 px band like every
  // other status line. No axe pass renders this failed state, so its resolved pairing is checked here.
  const noticeText = notice.locator('span');
  const fontSize = await noticeText.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSize, 'notice text size').toBeGreaterThanOrEqual(CAPTION_TEXT_RANGE.min);
  expect(fontSize, 'notice text size').toBeLessThanOrEqual(CAPTION_TEXT_RANGE.max);
  expect(await measureContrast(noticeText), 'notice text contrast').toBeGreaterThanOrEqual(4.5);
  await expect(page.getByRole('heading', { name: survivingHeading })).toBeVisible();
  await expect(page.locator('.moderation-grid article'), 'the cards the host was working on survive')
    .toHaveCount(2);

  const dismiss = page.getByRole('button', { name: 'Dismiss error', exact: true });
  const dismissSize = await measureTarget(dismiss);
  expect(dismissSize.width, 'dismiss target width').toBeGreaterThanOrEqual(44);
  expect(dismissSize.height, 'dismiss target height').toBeGreaterThanOrEqual(44);
  await expectContained(page);

  await dismiss.click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: survivingHeading })).toBeVisible();
}

test('a refused bulk publish keeps the gallery, its filter, and the selection', async ({ page }) => {
  await openGallery(page);
  await page.route(`${MANAGER_BASE}/media/bulk`, (route) => route.fulfill({
    status: 409, json: { ...MUTATION_REFUSED, requestId: 'request-a' },
  }));

  const first = page.locator('.moderation-grid article').first();
  await first.getByRole('checkbox').check();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Publish selected' }).click();

  await expectRecoverableNotice(page, 'Gallery publishing');
  // The filter the host had chosen and the selection they had made are both still true.
  await expect(page.locator('.filter-tabs button.active')).toHaveText('unpublished');
  await expect(page.getByText('1 selected')).toBeVisible();
  await expect(first.getByRole('checkbox')).toBeChecked();
});

test('a refused delete leaves the photo and the card it was deleted from', async ({ page }) => {
  await openGallery(page);
  await page.route(new RegExp(`/api/manage/events/${EVENT_FIXTURE.id}/media/[^/]+$`, 'u'), (route) => route.fulfill({
    status: 409, json: { ...MUTATION_REFUSED, requestId: 'request-a' },
  }));

  const first = page.locator('.moderation-grid article').first();
  await first.getByRole('button', { name: `Delete ${LONG_FILENAME}` }).click();

  await expectRecoverableNotice(page, 'Gallery publishing');
  // A refused delete that removed the card anyway would be the worst possible lie about a photo.
  await expect(first.locator('strong')).toHaveText(LONG_FILENAME);
});

test('a refused export request keeps the share section and the control that asked for it', async ({ page }) => {
  await openGallery(page);
  await page.route(`${MANAGER_BASE}/exports`, (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, json: { ...MUTATION_REFUSED, requestId: 'request-a' } })
    : route.fallback());

  await page.locator('.manager-nav nav button').filter({ hasText: 'Share' }).click();
  const panel = page.locator('.manager-export-panel--share');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Prepare download' }).click();

  const notice = page.getByRole('alert');
  await expect(notice).toContainText(MUTATION_REFUSED.message);
  await expect(page.getByRole('heading', { name: 'Share the photo drop' })).toBeVisible();
  // The panel that asked is still there, still able to ask again, rather than a dead section.
  await expect(panel.getByRole('button', { name: 'Prepare download' })).toBeEnabled();
  await expectContained(page);

  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a manager failure no retry could answer points at what does recover it, and offers none', async ({ page }) => {
  const cases = terminalFailures(MANAGER_LINK_HINT, MANAGER_LIFECYCLE_HINT);
  let failure = cases[0]!;
  await stubManagerRoutes(page, { mediaPages: { first: { media: makeMedia(1), nextCursor: null } } });
  await page.route(MANAGER_EVENT, (route) => route.fulfill({
    status: failure.status,
    json: { code: failure.code, message: failure.message, requestId: 'request-a' },
  }));

  for (const terminal of cases) {
    failure = terminal;
    await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);

    await expect(page.getByRole('alert'), terminal.code).toContainText(terminal.message);
    await expect(page.getByText(terminal.hint), terminal.code).toBeVisible();
    await expectAnnounced(page, terminal.message, terminal.hint);
    await expect(page.getByRole('button', { name: 'Try again', exact: true }), terminal.code)
      .toHaveCount(0);
    await expect(page.getByText(RETRY_HINT), terminal.code).toHaveCount(0);
    await expectContained(page);
  }
});

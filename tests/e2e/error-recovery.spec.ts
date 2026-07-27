import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { EVENT_FIXTURE, stubGuestRoutes, stubManagerRoutes } from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';
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
const RETRY_HINT = 'Your connection may have dropped. Try again in a moment.';
const GUEST_LINK_HINT = 'Open the latest guest link from your host to start again.';
const MANAGER_LINK_HINT = 'Open the latest management link you saved to start again.';

// Retrying cannot mint a session, so every one of these has to recover through a link rather than a
// button whose every press repeats the same refusal.
const LINK_FAILURES = [
  { code: 'SESSION_REQUIRED', status: 401, message: 'Open your event link again to continue.' },
  { code: 'SESSION_EXPIRED', status: 401, message: 'This session has expired.' },
  { code: 'TOKEN_REVOKED', status: 403, message: 'This link was replaced with a new one.' },
  { code: 'ROLE_FORBIDDEN', status: 403, message: 'This link does not open that view.' },
];

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

  await expect(page.getByRole('alert')).toHaveText(OFFLINE.message);
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

  await expect(page.getByRole('alert')).toHaveText(OFFLINE.message);
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

test('a guest link failure points at the link that recovers it and offers no retry', async ({ page }) => {
  let failure = LINK_FAILURES[0]!;
  await stubGuestRoutes(page);
  await page.route(GUEST_EVENT, (route) => route.fulfill({
    status: failure.status,
    json: { code: failure.code, message: failure.message, requestId: 'request-a' },
  }));

  for (const linkFailure of LINK_FAILURES) {
    failure = linkFailure;
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);

    await expect(page.getByRole('alert'), linkFailure.code).toHaveText(linkFailure.message);
    await expect(page.getByText(GUEST_LINK_HINT), linkFailure.code).toBeVisible();
    // A retry here could only repeat the refusal, so the state must not offer one at all.
    await expect(page.getByRole('button', { name: 'Try again', exact: true }), linkFailure.code)
      .toHaveCount(0);
    await expectContained(page);
  }
});

test('a manager link failure points at the link that recovers it and offers no retry', async ({ page }) => {
  let failure = LINK_FAILURES[0]!;
  await stubManagerRoutes(page, { mediaPages: { first: { media: makeMedia(1), nextCursor: null } } });
  await page.route(MANAGER_EVENT, (route) => route.fulfill({
    status: failure.status,
    json: { code: failure.code, message: failure.message, requestId: 'request-a' },
  }));

  for (const linkFailure of LINK_FAILURES) {
    failure = linkFailure;
    await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);

    await expect(page.getByRole('alert'), linkFailure.code).toHaveText(linkFailure.message);
    await expect(page.getByText(MANAGER_LINK_HINT), linkFailure.code).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again', exact: true }), linkFailure.code)
      .toHaveCount(0);
    await expectContained(page);
  }
});

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
const RECOVERY_EVENT_ID = '11111111-2222-4333-8444-555555555555';
const VALID_MANAGEMENT_TOKEN = 'Abc_123.Xyz-789';

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
    await expect(page.getByRole('textbox', { name: 'Management link' }), terminal.code).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Sign in' }), terminal.code).toHaveCount(0);
    await expectContained(page);
  }
});

test('a full-page expired manager validates links and a valid link-only recovery returns to the manager', async ({ page }) => {
  let recovered = false;
  const accountRequests: string[] = [];
  await stubManagerRoutes(page, {
    event: { id: RECOVERY_EVENT_ID },
    mediaPages: { first: { media: makeMedia(1), nextCursor: null } },
  });
  await page.route(new RegExp(`/api/manage/events/${RECOVERY_EVENT_ID}$`, 'u'), (route) => recovered
    ? route.fallback()
    : route.fulfill({
      status: 401,
      json: { code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a' },
    }));
  await page.route(`**/manage/${VALID_MANAGEMENT_TOKEN}`, (route) => {
    recovered = true;
    return route.fulfill({
      status: 302,
      headers: { location: `/manage/event/${RECOVERY_EVENT_ID}` },
    });
  });
  await page.route('**/api/host/**', (route) => {
    accountRequests.push(route.request().url());
    return route.fulfill({ json: { data: {}, requestId: 'request-a' } });
  });

  await page.goto(`/manage/event/${RECOVERY_EVENT_ID}`);
  await expect(page.getByRole('alert')).toContainText('This session has expired.');
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    `/host/login?returnTo=%2Fmanage%2Fevent%2F${RECOVERY_EVENT_ID}&adopt=${RECOVERY_EVENT_ID}`,
  );
  await expect(page.getByRole('textbox', { name: 'Management link' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);

  const managementLink = page.getByRole('textbox', { name: 'Management link' });
  await managementLink.fill('/manage/event');
  await page.getByRole('button', { name: 'Open event manager' }).click();
  await expect(managementLink).toBeFocused();
  await expect(managementLink).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter a Candidary management link.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/manage/event/${RECOVERY_EVENT_ID}$`, 'u'));

  await managementLink.fill(`/manage/${VALID_MANAGEMENT_TOKEN}?from=mail#saved`);
  await page.getByRole('button', { name: 'Open event manager' }).click();
  await expect(page).toHaveURL(new RegExp(`/manage/event/${RECOVERY_EVENT_ID}$`, 'u'));
  await expect(page.getByRole('heading', { name: EVENT_FIXTURE.name })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  expect(accountRequests, 'link-only recovery never authenticates or registers an account').toEqual([]);
});

test('a structurally valid stale link returns to token-free HTML recovery', async ({ page }) => {
  const staleToken = 'Stale_123.Link-456';
  await page.route(`**/manage/${staleToken}`, (route) => route.fulfill({
    status: 302,
    headers: { location: '/recover/manage?kind=latest-link' },
  }));

  await page.goto('/recover/manage');
  await page.getByRole('textbox', { name: 'Management link' }).fill(`/manage/${staleToken}`);
  await page.getByRole('button', { name: 'Open event manager' }).click();

  await expect(page).toHaveURL(/\/recover\/manage\?kind=latest-link$/u);
  await expect(page.getByRole('heading', { name: 'Recover event manager' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Management link' })).toBeVisible();
  expect(page.url()).not.toContain(staleToken);
  await expect(page.locator('body')).not.toContainText('"requestId"');
});

test('event-aware sign-in returns to an event already saved to the account', async ({ page }) => {
  let authenticated = false;
  await stubManagerRoutes(page, {
    event: { id: RECOVERY_EVENT_ID },
    mediaPages: { first: { media: makeMedia(1), nextCursor: null } },
  });
  await page.route(new RegExp(`/api/manage/events/${RECOVERY_EVENT_ID}$`, 'u'), (route) => authenticated
    ? route.fallback()
    : route.fulfill({
      status: 401,
      json: { code: 'HOST_SESSION_REQUIRED', message: 'Your sign-in has expired.', requestId: 'request-a' },
    }));
  await page.route('**/api/host/login', (route) => {
    authenticated = true;
    return route.fulfill({ json: { data: { signedIn: true }, requestId: 'request-a' } });
  });
  await page.route(`**/api/host/events/${RECOVERY_EVENT_ID}/adopt`, (route) => route.fulfill({
    json: { data: { adopted: false, alreadySaved: true }, requestId: 'request-a' },
  }));

  await page.goto(`/manage/event/${RECOVERY_EVENT_ID}`);
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(
    `/host/login\\?returnTo=%2Fmanage%2Fevent%2F${RECOVERY_EVENT_ID}&adopt=${RECOVERY_EVENT_ID}$`,
    'u',
  ));
  await page.getByLabel('Email address').fill('host@example.com');
  await page.getByLabel('Password').fill('a-sufficiently-long-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(new RegExp(`/manage/event/${RECOVERY_EVENT_ID}$`, 'u'));
  await expect(page.getByRole('heading', { name: EVENT_FIXTURE.name })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
});

test('the token-free recovery route defaults safely and ended events stay terminal', async ({ page }) => {
  for (const path of ['/recover/manage', '/recover/manage?kind=unknown']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Recover event manager' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/host/login');
    await expect(page.getByRole('textbox', { name: 'Management link' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);
  }

  await page.goto('/recover/manage?kind=ended-event');
  await expect(page.getByRole('heading', { name: 'This event can no longer be managed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Management link' })).toHaveCount(0);
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
  await expect(page.getByRole('heading', { name: 'Private Gallery' })).toBeVisible();
}

async function openSharedGallery(page: Page) {
  await openGallery(page);
  await page.getByRole('button', { name: 'Guest gallery' }).click();
  await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Guest gallery' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.moderation-grid article')).toHaveCount(2);
}

// The notice has to be readable, actionable by thumb, and contained — and everything it interrupted
// has to still be there underneath it. Manager actions are dismissible; Guest gallery owns an exact retry.
async function expectRecoverableNotice(
  page: Page,
  survivingHeading: string,
  control: 'dismiss' | 'retry' = 'dismiss',
) {
  const notice = page.getByRole('alert');
  await expect(notice).toContainText(MUTATION_REFUSED.message);
  // The notice is caption-weight prose, so it lives in the design system's 12–14 px band like every
  // other status line. No axe pass renders this failed state, so its resolved pairing is checked here.
  const noticeText = control === 'retry'
    ? notice.getByText(RETRY_HINT, { exact: true })
    : notice.locator('span').first();
  const fontSize = await noticeText.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSize, 'notice text size').toBeGreaterThanOrEqual(CAPTION_TEXT_RANGE.min);
  expect(fontSize, 'notice text size').toBeLessThanOrEqual(CAPTION_TEXT_RANGE.max);
  expect(await measureContrast(noticeText), 'notice text contrast').toBeGreaterThanOrEqual(4.5);
  await expect(page.getByRole('heading', { name: survivingHeading })).toBeVisible();
  await expect(page.locator('.moderation-grid article'), 'the cards the host was working on survive')
    .toHaveCount(2);

  const recoveryControl = page.getByRole('button', {
    name: control === 'dismiss' ? 'Dismiss error' : 'Try again',
    exact: true,
  });
  const recoverySize = await measureTarget(recoveryControl);
  expect(recoverySize.width, 'recovery target width').toBeGreaterThanOrEqual(44);
  expect(recoverySize.height, 'recovery target height').toBeGreaterThanOrEqual(44);
  await expectContained(page);

  if (control === 'dismiss') {
    await recoveryControl.click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: survivingHeading })).toBeVisible();
  }
}

test('a refused bulk publish keeps the gallery, its filter, and the selection', async ({ page }) => {
  await openSharedGallery(page);
  const bulkPayloads: unknown[] = [];
  await page.route(`${MANAGER_BASE}/media/bulk`, (route) => {
    bulkPayloads.push(route.request().postDataJSON());
    return bulkPayloads.length === 1
      ? route.fulfill({ status: 409, json: { ...MUTATION_REFUSED, requestId: 'request-a' } })
      : route.fallback();
  });

  const tray = page.getByRole('region', { name: 'Guest gallery', exact: true });
  const first = page.locator('.moderation-grid article').first();
  await page.getByRole('button', { name: 'Select photos' }).click();
  await first.getByRole('checkbox').check();
  await expect(tray.locator('#bulk-selection-status strong')).toHaveText('1 of 50 selected');
  await tray.getByRole('button', { name: 'Publish (1)' }).click();

  await expectRecoverableNotice(page, 'Gallery', 'retry');
  // The filter the host had chosen and the selection they had made are both still true.
  await expect(page.locator('.filter-tabs button.active')).toHaveText('Unpublished');
  await expect(tray.locator('#bulk-selection-status strong')).toHaveText('1 of 50 selected');
  await expect(first.getByRole('checkbox')).toBeChecked();

  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.poll(() => bulkPayloads.length).toBe(2);
  expect(bulkPayloads[0]).toMatchObject({ action: 'publish', expectedStatus: 'unpublished' });
  expect(bulkPayloads[1]).toEqual(bulkPayloads[0]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The write consumed the selection, so the tray retires rather than standing there holding a
  // zero — which is the whole reason Guest gallery moved onto it.
  await expect(tray).toHaveCount(0);
  await expect(page.locator('.moderation-grid article')).toHaveCount(1);
});

test('a refused move to Recently deleted leaves the photo and its Intake card', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: makeMedia(2, 'unpublished'), nextCursor: null } },
    event: { storedMediaCount: 2 },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  let trashRequests = 0;
  await page.route(`${MANAGER_BASE}/media/*/trash`, (route) => {
    trashRequests += 1;
    return route.fulfill({ status: 409, json: { ...MUTATION_REFUSED, requestId: 'request-a' } });
  });

  const first = page.locator('.moderation-grid article').first();
  await first.getByRole('button', { name: `Move ${LONG_FILENAME} to Recently deleted` }).click();
  await expect(page.getByRole('dialog', { name: 'Move this photo to Recently deleted?' })).toBeVisible();
  expect(trashRequests).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Recently deleted' }).click();

  await expectRecoverableNotice(page, 'Live intake');
  expect(trashRequests).toBe(1);
  // A refused delete that removed the card anyway would be the worst possible lie about a photo.
  await expect(first.locator('strong')).toHaveText(LONG_FILENAME);
});

test('a refused export request keeps the gallery and the control that asked for it', async ({ page }) => {
  await openGallery(page);
  await page.route(`${MANAGER_BASE}/exports`, (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, json: { ...MUTATION_REFUSED, requestId: 'request-a' } })
    : route.fallback());

  // Found by name rather than by container: below 761 the first ask is docked to the thumb bar and
  // the export panel holds only the status, which does not exist yet.
  const control = page.getByRole('button', { name: 'Download all' });
  await expect(control).toBeVisible();
  await control.click();

  const notice = page.getByRole('alert');
  await expect(notice).toContainText(MUTATION_REFUSED.message);
  await expect(page.getByRole('heading', { name: 'Private Gallery' })).toBeVisible();
  // The control that asked is still there, still able to ask again, rather than a dead section.
  await expect(control).toBeEnabled();
  await expectContained(page);

  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('manager access failures offer the usable credential routes while ended events remain terminal', async ({ page }) => {
  const cases = [
    ...LINK_FAILURES.map((failure) => ({ ...failure, hint: MANAGER_LINK_HINT, signIn: true, link: true })),
    { code: 'HOST_SESSION_REQUIRED', status: 401, message: 'Your sign-in has expired.', hint: 'Sign in with your email and password to continue.', signIn: true, link: true },
    { code: 'ACCOUNT_DISABLED', status: 403, message: 'This account is no longer active.', hint: MANAGER_LINK_HINT, signIn: false, link: true },
    ...LIFECYCLE_FAILURES.map((failure) => ({ ...failure, hint: MANAGER_LIFECYCLE_HINT, signIn: false, link: false })),
  ];
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
    await expect(page.getByRole('link', { name: 'Sign in' }), terminal.code)
      .toHaveCount(terminal.signIn ? 1 : 0);
    await expect(page.getByRole('textbox', { name: 'Management link' }), terminal.code)
      .toHaveCount(terminal.link ? 1 : 0);
    await expect(page.getByRole('link', { name: 'Create account' }), terminal.code).toHaveCount(0);
    await expectContained(page);
  }
});

test('an inline expired-session notice preserves the manager and exposes both recovery routes', async ({ page }) => {
  let mediaRequests = 0;
  await stubManagerRoutes(page, {
    event: { id: RECOVERY_EVENT_ID },
    mediaPages: { first: { media: makeMedia(1), nextCursor: null } },
  });
  await page.route(`**/api/manage/events/${RECOVERY_EVENT_ID}/media*`, (route) => {
    mediaRequests += 1;
    return mediaRequests > 1
      ? route.fulfill({
        status: 401,
        json: { code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a' },
      })
      : route.fallback();
  });

  await page.goto(`/manage/event/${RECOVERY_EVENT_ID}`);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await page.getByLabel('Filter by guest name').fill('Avery');
  await page.getByRole('button', { name: 'Filter' }).click();

  await expect(page.getByRole('alert')).toContainText('This session has expired.');
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  // A query owns its rows and cursor. The unfiltered page must not masquerade as the failed Avery
  // result, but the chosen filter and the rest of the Manager remain available for recovery.
  await expect(page.getByLabel('Filter by guest name')).toHaveValue('Avery');
  await expect(page.locator('.moderation-grid article')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No matching photos.' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    `/host/login?returnTo=%2Fmanage%2Fevent%2F${RECOVERY_EVENT_ID}&adopt=${RECOVERY_EVENT_ID}`,
  );
  await expect(page.getByRole('textbox', { name: 'Management link' })).toBeVisible();
  await expect(page.getByRole('alert').locator('form')).toHaveCount(0);
});

import { expect, test } from '@playwright/test';

import {
  EVENT_ENTRY_FIXTURE_TOKEN,
  EVENT_FIXTURE,
  RSVP_HOUSEHOLD_FIXTURE,
  eventTheme,
  stubEntryExchange,
  stubGuestRoutes,
  stubManagerRoutes,
  stubRsvpRosterBatchRoutes,
} from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';
import { settleRendering } from './helpers/rendering';

test('application routes never retain access secrets in rendered links', async ({ page }) => {
  await stubGuestRoutes(page, { event: { welcomeMessage: 'Welcome.', galleryVisible: false } });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await expect(page).toHaveURL(new RegExp(`/event/${EVENT_FIXTURE.slug}$`, 'u'));
  await expect(page.locator('a[href*="guest-secret"], a[href*="manager-secret"]')).toHaveCount(0);
});

// Only the SPA documents are asserted here. Entry-exchange and RSVP API headers
// are Worker behaviour and are proved in `tests/worker/security-headers.test.ts`
// and `tests/worker/event-entry-api.test.ts`; a route stub could not prove them.
test('every deep-linkable SPA document carries the shipped security headers', async ({ page }) => {
  await stubGuestRoutes(page, { event: { galleryVisible: false } });
  await stubManagerRoutes(page, { mediaPages: { first: { media: makeMedia(1), nextCursor: null } } });

  for (const path of [
    `/event/${EVENT_FIXTURE.slug}`,
    `/manage/event/${EVENT_FIXTURE.id}`,
    '/recover/event-entry?kind=unavailable',
    '/join',
  ]) {
    const response = await page.goto(path);
    const headers = response?.headers() ?? {};
    expect(headers['content-security-policy'], `${path} CSP`).toContain("default-src 'self'");
    expect(headers['content-security-policy'], `${path} frame ancestors`).toContain("frame-ancestors 'none'");
    // The printed credential lives in a fragment, so a referrer must never leave.
    expect(headers['referrer-policy'], `${path} referrer policy`).toBe('no-referrer');
    expect(headers['x-content-type-options'], `${path} sniffing`).toBe('nosniff');
  }
});

test('a scanned entry leaves no credential in the URL, the page, or the console', async ({ page }) => {
  const consoleMessages: string[] = [];
  const requestUrls: string[] = [];
  page.on('console', (message) => consoleMessages.push(message.text()));
  page.on('pageerror', (error) => consoleMessages.push(error.message));
  page.on('request', (request) => requestUrls.push(request.url()));

  await stubGuestRoutes(page, {
    event: {
      uploadsEnabled: false,
      phase: 'rsvp-primary',
      rsvpState: 'open',
      rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
      rsvpDeadlineDate: '2026-09-05',
    },
    household: RSVP_HOUSEHOLD_FIXTURE,
    rsvpSession: false,
  });
  const lookupPath = `**/api/event/${EVENT_FIXTURE.slug}/rsvp/lookup`;
  await page.unroute(lookupPath);
  await page.route(lookupPath, (route) => {
    const body = route.request().postDataJSON() as { firstName?: string };
    const matched = body.firstName?.trim() === 'Taylor Morgan';
    return route.fulfill({
      json: {
        data: matched
          ? { status: 'matched', household: RSVP_HOUSEHOLD_FIXTURE }
          : {
              status: 'not_available',
              message: 'We could not open an invitation with those details.',
            },
        requestId: 'request-a',
      },
    });
  });
  await stubEntryExchange(page);
  await page.goto(`/join#${EVENT_ENTRY_FIXTURE_TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Find your household invitation' })).toBeVisible();

  expect(page.url(), 'the address bar keeps no credential').not.toContain(EVENT_ENTRY_FIXTURE_TOKEN);
  expect(
    requestUrls.every((url) => !url.includes(EVENT_ENTRY_FIXTURE_TOKEN)),
    'no request line or query carried the credential',
  ).toBe(true);

  // Before a match, the page knows nothing about the roster it might unlock.
  const beforeMatch = await page.content();
  expect(beforeMatch).not.toContain(EVENT_ENTRY_FIXTURE_TOKEN);
  expect(beforeMatch).not.toContain(RSVP_HOUSEHOLD_FIXTURE.id);
  expect(beforeMatch).not.toContain(RSVP_HOUSEHOLD_FIXTURE.label);
  for (const invitee of RSVP_HOUSEHOLD_FIXTURE.invitees) {
    expect(beforeMatch, 'no invitee id is present before a match').not.toContain(invitee.id);
  }

  await page.getByLabel('Full name').fill('Nobody At All');
  await page.getByRole('button', { name: 'Find my invitation' }).click();
  await expect(page.getByText('We could not open an invitation with those details.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toHaveCount(0);
  const refused = await page.locator('body').innerText();
  expect(refused).not.toContain(RSVP_HOUSEHOLD_FIXTURE.id);
  expect(refused).not.toContain(RSVP_HOUSEHOLD_FIXTURE.label);
  for (const invitee of RSVP_HOUSEHOLD_FIXTURE.invitees) {
    expect(refused).not.toContain(invitee.id);
    if (invitee.displayName) expect(refused).not.toContain(invitee.displayName);
  }
  expect(
    consoleMessages.every((message) => !message.includes(RSVP_HOUSEHOLD_FIXTURE.label)),
    'a failed lookup never logs roster details',
  ).toBe(true);

  await page.getByLabel('Full name').fill('Taylor Morgan');
  await page.getByRole('button', { name: 'Find my invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();
  expect(
    consoleMessages.every((message) => !message.includes(EVENT_ENTRY_FIXTURE_TOKEN)),
    'the console never repeats the credential',
  ).toBe(true);
});

test('a refused staged guest list forgets its private source after discard', async ({ page }) => {
  const secretRow = 'perkins,Perkins household,Henry Perkins,1';
  const csv = `household_key,household_label,invitee_name,plus_one_slots\n${secretRow}\n`;
  const consoleMessages: string[] = [];
  page.on('console', (message) => consoleMessages.push(message.text()));

  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await stubRsvpRosterBatchRoutes(page, EVENT_FIXTURE.id, {
    preview: ({ request, defaultResponse }) => {
      const firstHousehold = request.batch.creates[0]!;
      const firstInvitee = firstHousehold.namedInvitees[0]!;
      return {
        ...defaultResponse,
        issues: [{
          clientHouseholdId: firstHousehold.clientHouseholdId,
          clientInviteeId: firstInvitee.clientInviteeId,
          field: 'namedInvitees.displayName',
          code: 'invitee_name_invalid',
          message: 'Enter each named guest from 1 to 80 characters.',
          severity: 'blocking',
        }],
        canCommit: false,
      };
    },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}?section=rsvp`);
  await page.getByRole('button', { name: 'Add guests' }).click();
  await page.getByLabel('Choose guest-list file').setInputFiles({
    name: 'guests.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Review guests' }).click();

  const issues = page.getByRole('region', { name: 'Guest list review issues' });
  await expect(issues).toBeVisible();
  await expect(issues, 'server issue copy does not independently echo the private row')
    .not.toContainText(secretRow);
  await expect(issues).not.toContainText('Henry Perkins');
  expect(
    consoleMessages.every((message) => !message.includes('Henry Perkins')),
    'a refused preview never logs the file',
  ).toBe(true);

  await page.getByRole('button', { name: 'Close' }).click();
  const prompt = page.getByRole('region', { name: 'Your pending work is not saved' });
  await expect(prompt).toBeFocused();
  await prompt.getByRole('button', { name: 'Discard draft' }).click();

  await expect(page.getByRole('button', { name: 'Add guests' })).toBeVisible();
  await expect(page.getByLabel('Guest names or spreadsheet data')).toHaveCount(0);
  expect(await page.content(), 'discard removes the private source from the rendered DOM')
    .not.toContain('Henry Perkins');
});

test('production preview enforces the shipped CSP while themed cover images render', async ({ page }) => {
  const consoleErrors: string[] = [];
  const fontRequests: string[] = [];
  // Keep a real production asset request open long enough to prove the console audit waits for it.
  await page.route(/\/assets\/.*\.woff2?$/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontRequests.push(request.url());
  });
  await stubGuestRoutes(page, {
    event: {
      theme: eventTheme('midnight-film'),
      coverObjectKey: 'events/event-a/cover.png',
    },
  });
  const response = await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(response?.headers()['content-security-policy']).toContain("img-src 'self' blob: data:");
  await expect(page.locator('.photo-drop__hero--cover')).toHaveCSS('background-image', /blob:/u);
  const settlement = await settleRendering(page);
  expect(fontRequests, 'production build requests emitted font assets').not.toEqual([]);
  const pageOrigin = new URL(page.url()).origin;
  expect(fontRequests.every((url) => new URL(url).origin === pageOrigin), 'font assets stay same-origin').toBe(true);
  expect(
    fontRequests.every((url) => /^\/assets\/.*\.woff2?$/u.test(new URL(url).pathname)),
    'font requests are emitted build assets',
  ).toBe(true);
  expect(settlement.fontStatus, 'font work is settled before the console audit').toBe('loaded');
  expect(settlement.frames, 'font status stayed observable across a two-frame boundary').toBeGreaterThanOrEqual(2);
  expect(consoleErrors, 'production CSP emits no browser console error').toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';

const eventId = '11111111-2222-4333-8444-555555555555';
const manager = `/manage/event/${eventId}`;
const deadlineNote = /You can save this event to an account until/;
type Status = 'link' | 'unseen' | 'dismissed' | 'completed';

// Each explicit viewport/scenario has one owner; the second configured project
// deliberately skips it instead of duplicating this matrix.
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Explicit viewport matrix is owned by desktop project.');
});

async function stubEntry(page: Page, initial: Status, boundEvent = true) {
  let status = initial;
  let signedIn = initial !== 'link';
  const writes: string[] = [];
  await stubManagerRoutes(page, { event: { id: eventId, storedMediaCount: 0 }, mediaPages: { first: { media: [], nextCursor: null } } });
  await page.route(`**/api/manage/events/${eventId}/lifecycle`, route => route.fulfill({ json: { data: {
    phase: 'photos-primary', rsvpState: 'disabled', photoIntakeState: 'open', guestAccessEnded: false, entryDisabled: false, lifecycleRecheckAfterMs: null,
  } } }));
  await page.route('**/api/host/session', route => route.fulfill(signedIn
    ? { json: { data: { account: { id: 'host-entry', email: 'host@example.test', emailVerified: true }, events: boundEvent ? [{ id: eventId }] : [] } } }
    : { status: 401, json: { code: 'UNAUTHORIZED' } }));
  await page.route('**/api/host/tours/host-event-welcome/1', async route => {
    if (!signedIn) return route.fulfill({ status: 401, json: { code: 'UNAUTHORIZED' } });
    if (route.request().method() === 'PATCH') {
      expect(route.request().headers()['x-candidary-tour-account-id']).toBe('host-entry');
      status = route.request().postDataJSON().status;
      writes.push(status);
    }
    return route.fulfill({ json: { data: { accountId: 'host-entry', tourKey: 'host-event-welcome', version: 1, status } } });
  });
  await page.route('**/api/events', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toMatchObject({ name: EVENT_FIXTURE.name, eventDate: '2026-09-19', eventStartTime: '17:00', eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05', welcomeMessage: 'Share the moments you caught.' });
    await route.fulfill({ status: 201, json: { data: { event: { ...EVENT_FIXTURE, id: eventId }, eventLink: 'http://127.0.0.1:4175/join#entry.secret', managementLink: 'http://127.0.0.1:4175/manage/private-secret', csrfToken: 'csrf-entry', savedToAccount: signedIn } } });
  });
  await page.route('**/api/host/register', async route => {
    expect(route.request().postDataJSON()).toMatchObject({ bindEventId: eventId });
    await route.fulfill({ status: 202, json: { data: { registrationPending: true, resumeExpiresAt: '2099-01-01T00:15:00Z' } } });
  });
  await page.route('**/api/host/register/complete', async route => {
    expect(route.request().postDataJSON()).toEqual({ code: '424242' });
    signedIn = true; status = 'unseen';
    await route.fulfill({ json: { data: { registered: true, boundEvent } } });
  });
  const mutations: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/manage/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.url());
  });
  return { writes, mutations };
}

async function createEvent(page: Page) {
  await page.goto('/create');
  await page.getByLabel('Event name', { exact: true }).fill(EVENT_FIXTURE.name);
  await page.getByLabel('Event date', { exact: true }).fill('2026-09-19');
  await page.getByLabel('Event start time', { exact: true }).fill('17:00');
  await page.getByLabel('Event time zone', { exact: true }).fill('America/Chicago');
  await page.getByLabel('RSVP deadline', { exact: true }).fill('2026-09-05');
  await page.getByLabel('Welcome message', { exact: true }).fill('Share the moments you caught.');
  await page.getByRole('button', { name: 'Create private event', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your event is ready.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue to your event', exact: true })).toHaveAttribute('href', `${manager}?section=overview`);
  await expect(page.getByText('Keep your management link private.', { exact: true })).toBeVisible();
}

test('anonymous creation reaches Overview and opens introduction without registration', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const audit = await stubEntry(page, 'link');
  await createEvent(page);
  await expect(page.getByText(deadlineNote)).toBeVisible();
  await expect(page.getByText(/Without an account, it cannot be recovered/)).toBeVisible();
  await page.getByRole('link', { name: 'Continue to your event', exact: true }).click();
  await expect(page).toHaveURL(`${manager}?section=overview`);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show me how to collect photos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Collect photos privately', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Show me how to collect photos', exact: true })).toBeFocused();
  expect(audit.writes).toEqual([]); expect(audit.mutations).toEqual([]);
});

test('signed-in creation shows saved receipt and unseen introduction once with manual replay', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const audit = await stubEntry(page, 'unseen');
  await createEvent(page);
  await expect(page.getByText('Saved to your account', { exact: true })).toBeVisible();
  await expect(page.getByText(deadlineNote)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Continue to your event', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Collect photos privately', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(() => audit.writes).toEqual(['dismissed']);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Choose your next task' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show me how to collect photos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Collect photos privately', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Tour event tools', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your next task', exact: true })).toBeFocused();
  await expect(page.getByText('Step 1 of 6', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(audit.mutations).toEqual([]);
});

for (const boundEvent of [true, false]) {
  test(`creation registration preserves Overview return and truthful adoption ${boundEvent}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const audit = await stubEntry(page, 'link', boundEvent);
    await createEvent(page);
    await page.getByLabel('Email address', { exact: true }).fill('host@example.test');
    await page.getByLabel('Password', { exact: true }).fill('a-sufficiently-long-password');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/host/register');
    const search = new URL(page.url()).searchParams;
    expect(search.get('returnTo')).toBe(`${manager}?section=overview`);
    expect(search.get('adopt')).toBe(eventId); expect(search.get('pending')).toBe('1');
    await expect(page.getByText(/still depends on its management link/)).toBeVisible();
    await expect(page.getByText('Saved to your account', { exact: true })).toHaveCount(0);
    await page.getByLabel('Confirmation code', { exact: true }).fill('424242');
    await page.getByRole('button', { name: 'Confirm my email', exact: true }).click();
    if (boundEvent) {
      await expect(page).toHaveURL(`${manager}?section=overview`);
      await expect(page.getByRole('heading', { name: 'Collect photos privately', exact: true })).toBeFocused();
    } else {
      await expect(page.getByText(/it was not added to your account/)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Continue to Host Events' })).toHaveAttribute('href', '/host/events');
      expect(new URL(page.url()).pathname).toBe('/host/register');
      expect(new URL(page.url()).searchParams.has('pending')).toBe(false);
    }
    expect(audit.mutations).toEqual([]);
  });
}

for (const status of ['dismissed', 'completed'] as const) {
  test(`${status} accounts keep Overview available without forced introduction`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const audit = await stubEntry(page, status);
    await page.goto(`${manager}?section=overview`);
    await expect(page.getByRole('heading', { name: 'Choose your next task' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show me how to collect photos', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Collect photos privately', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Choose your next task' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(audit.writes).toEqual([]); expect(audit.mutations).toEqual([]);
  });
}

for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`first Overview viewport shows identity phase task and secondary help at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await stubEntry(page, 'link');
    await page.goto(`${manager}?section=overview`);
    const identity = page.getByRole('heading', { name: EVENT_FIXTURE.name, exact: true });
    const phase = page.locator('.manager-overview__phase');
    const primary = page.locator('[data-host-tour-recommended-action]');
    const help = page.getByRole('button', { name: 'Show me how to collect photos', exact: true });
    await expect(primary).toHaveText('Share your QR');
    await expect(phase).toHaveText('Photo delivery is open');
    for (const target of [identity, phase, primary, help]) await expect(target).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(await help.evaluate(el => el.closest('[data-host-tour-anchor]')?.getAttribute('data-host-tour-anchor'))).toBe('overview-task');
    const tools = page.getByRole('button', { name: 'Tour event tools', exact: true });
    expect(await tools.evaluate(el => el.closest('section')?.getAttribute('aria-labelledby'))).toBe('overview-workflows-title');
    await page.screenshot({ path: `output/playwright/onboarding-remediation-2026-10-11/task-4/overview-${viewport.width}.png` });
  });
}

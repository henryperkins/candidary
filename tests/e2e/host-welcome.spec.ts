import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { chooseManagerSection } from './helpers/manager-navigation';
const manager = `/manage/event/${EVENT_FIXTURE.id}`;
const tourPath = '**/api/host/tours/host-event-welcome/1';
async function stubWelcome(page: Page, status: 'unseen' | 'dismissed' | 'completed' | 'link' = 'unseen', expired = false) {
  await stubManagerRoutes(page, { event: { name: 'Alexandria and Christopher celebrate with family and friends' }, mediaPages: { first: { media: [], nextCursor: null } } });
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/lifecycle`, route => route.fulfill({ json: { data: { phase: 'photos-primary', rsvpState: 'disabled', photoIntakeState: 'open', guestAccessEnded: expired, entryDisabled: false, lifecycleRecheckAfterMs: null } } }));
  const writes: string[] = [];
  await page.route(tourPath, async route => {
    if (route.request().method() === 'PATCH') { writes.push(route.request().postDataJSON().status); expect(route.request().headers()['x-candidary-tour-account-id']).toBe('host-a'); }
    await route.fulfill(status === 'link' ? { status: 401, json: { code: 'UNAUTHORIZED' } } : { json: { data: { accountId: 'host-a', tourKey: 'host-event-welcome', version: 1, status } } });
  });
  return writes;
}
const titles = ['Your next task', 'Your guest list', 'One QR for your event', 'Your delivered photos', 'Keep your originals', 'Event details and access'];

test('six safe steps, focus, Back, Finish, and account replay', async ({ page }) => {
  const writes = await stubWelcome(page);
  const eventMutations: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/manage/') && !['GET', 'HEAD'].includes(request.method())) eventMutations.push(request.url()); });
  await page.goto(`${manager}?section=overview`);
  for (let index = 0; index < titles.length; index += 1) {
    const title = page.getByRole('heading', { name: titles[index], exact: true });
    await expect(title).toBeFocused();
    await expect(page.getByText(`Step ${index + 1} of 6`, { exact: true })).toBeVisible();
    await expect(page.locator('#root')).toHaveAttribute('inert');
    const forward = page.getByRole('button', { name: index === 5 ? 'Finish' : 'Next', exact: true });
    await expect(forward).toBeEnabled();
    if (index === 1) {
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page.getByRole('heading', { name: titles[0], exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(title).toBeFocused();
      await expect(forward).toBeEnabled();
    }
    await forward.click();
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-host-tour-recommended-action]')).toBeFocused();
  expect(writes).toEqual(['completed']);
  expect(eventMutations).toEqual([]);
  await page.getByRole('button', { name: 'Take a tour' }).click();
  await expect(page.getByRole('heading', { name: titles[0], exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Take a tour' })).toBeFocused();
  expect(writes).toEqual(['completed']);
});

test('direct Library stays at work, manual link replay and originals action only focus export controls', async ({ page }) => {
  await stubWelcome(page, 'link', true);
  const mutations: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/manage/') && r.method() !== 'GET') mutations.push(r.url()); });
  await page.goto(manager);
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await chooseManagerSection(page, 'Overview');
  await page.getByRole('button', { name: 'Retrieve originals', exact: true }).click();
  await expect(page.locator('.gallery-export-tools')).toHaveAttribute('open', '');
  await expect(page.locator('.gallery-export-tools :focus')).toHaveCount(1);
  expect(mutations).toEqual([]);
  await chooseManagerSection(page, 'Overview');
  await page.getByRole('button', { name: 'Take a tour' }).click();
  await expect(page.getByRole('heading', { name: titles[0], exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('browser Back leaves the tour without a forced redirect', async ({ page }) => {
  await stubWelcome(page, 'dismissed');
  await page.goto(manager);
  await chooseManagerSection(page, 'Overview');
  await page.getByRole('button', { name: 'Take a tour' }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/section=overview/);
});

test('Overview and anchored tour remain usable across sizes, enlarged text and reduced motion', async ({ page }, testInfo) => {
  await stubWelcome(page, 'dismissed');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${manager}?section=overview`);
  const sizes = testInfo.project.name === 'desktop' ? [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'enlarged', width: 320, height: 700 }] : [{ name: '390', width: 390, height: 844 }, { name: '320', width: 320, height: 568 }];
  for (const size of sizes) {
    await page.setViewportSize(size);
    if (size.name === 'enlarged') await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('[data-host-tour-recommended-action]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `output/host-welcome/${size.name}-overview.png` });
    await page.getByRole('button', { name: 'Take a tour' }).click();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await expect.poll(() => page.locator('.host-welcome__target').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(0);
    await page.screenshot({ path: `output/host-welcome/${size.name}-tour.png` });
    const panel = await page.locator('.host-welcome__panel').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0); expect(panel!.x + panel!.width).toBeLessThanOrEqual(size.width);
    expect(panel!.y).toBeGreaterThanOrEqual(0); expect(panel!.y + panel!.height).toBeLessThanOrEqual(size.height);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Close tour' })).toBeFocused();
    const axe = await new AxeBuilder({ page }).include('.host-welcome').analyze();
    expect(axe.violations).toEqual([]);
    if (size.name === 'enlarged') {
      await page.getByRole('button', { name: 'Next', exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeInViewport();
    }
    await page.keyboard.press('Escape');
  }
});

test('a competing dialog suspends guidance and a dirty guest-list guard retains the current step', async ({ page }) => {
  await stubWelcome(page);
  await page.goto(`${manager}?section=overview`);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your guest list', exact: true })).toBeVisible();
  // Model a child portal taking ownership while asynchronous work arrives.
  await page.evaluate(() => { const dialog = document.createElement('div'); dialog.id = 'test-child-dialog'; dialog.setAttribute('role', 'dialog'); document.body.append(dialog); });
  await expect(page.locator('[data-host-welcome-tour]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add guests', exact: true }).click();
  await page.getByLabel('Guest names or spreadsheet data').fill('Avery Lee');
  await page.evaluate(() => document.getElementById('test-child-dialog')?.remove());
  await expect(page.getByRole('heading', { name: 'Your guest list', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your pending work is not saved' })).toBeVisible();
  await expect(page.locator('[data-host-welcome-tour]')).toHaveCount(0);
  await expect(page.locator('#root')).not.toHaveAttribute('inert');
  await page.getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your guest list', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Guest names or spreadsheet data')).toHaveValue('Avery Lee');
  await expect(page).toHaveURL(/section=rsvp/);
});

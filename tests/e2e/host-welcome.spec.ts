import { mkdir, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Locator } from '@playwright/test';
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
  const writes = await stubWelcome(page, 'dismissed');
  const eventMutations: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/manage/') && !['GET', 'HEAD'].includes(request.method())) eventMutations.push(request.url()); });
  await page.goto(`${manager}?section=overview`);
  await page.getByRole('button', { name: 'Tour event tools' }).click();
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
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  await expect(page.getByRole('heading', { name: titles[0], exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Tour event tools' })).toBeFocused();
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
  await expect(page.getByRole('button', { name: 'Exports', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.gallery-export-tools :focus')).toHaveCount(1);
  expect(mutations).toEqual([]);
  await chooseManagerSection(page, 'Overview');
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  await expect(page.getByRole('heading', { name: titles[0], exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('onboarding-focus: browser Back after advancing focuses the committed Overview without redirect', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One project owns committed Back focus at the explicit 375px viewport.');
  await page.setViewportSize({ width: 375, height: 667 });
  await stubWelcome(page, 'dismissed');
  await page.goto(manager);
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await chooseManagerSection(page, 'Overview');
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: titles[1], exact: true })).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/section=overview/);
  await expectVisibleWorkspaceFocus(page, page.locator('[data-host-tour-recommended-action]'));
  await page.screenshot({ path: 'output/playwright/onboarding-remediation-2026-10-11/task-2/back-overview.png' });
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
    await page.screenshot({ path: `output/host-welcome-remediation/${size.name}-overview.png` });
    await page.getByRole('button', { name: 'Tour event tools' }).click();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await expect.poll(() => page.locator('.host-welcome__target').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(0);
    await page.screenshot({ path: `output/host-welcome-remediation/${size.name}-tour.png` });
    const panel = await page.locator('.host-welcome__panel').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0); expect(panel!.x + panel!.width).toBeLessThanOrEqual(size.width);
    expect(panel!.y).toBeGreaterThanOrEqual(0); expect(panel!.y + panel!.height).toBeLessThanOrEqual(size.height);
    if (size.width <= 760) {
      const target = await page.locator('.host-welcome__target').boundingBox();
      const action = await page.locator('[data-host-tour-recommended-action]').boundingBox();
      expect(target!.y + target!.height + 12).toBeLessThanOrEqual(panel!.y);
      const navigation = await page.locator('.manager-nav').boundingBox();
      expect(action!.y).toBeGreaterThanOrEqual(navigation!.y + navigation!.height + 8);
      expect(action!.y + action!.height + 12).toBeLessThanOrEqual(panel!.y);
      await expect(page.locator('[data-host-tour-recommended-action]')).toBeInViewport({ ratio: 1 });
    }
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

test('onboarding-focus: a refused dirty guest-list guard keeps its step and draft', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One project owns guard refusal at the explicit 375px viewport.');
  await page.setViewportSize({ width: 375, height: 667 });
  await stubWelcome(page, 'dismissed');
  await page.goto(`${manager}?section=overview`);
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your guest list', exact: true })).toBeVisible();
  // Model a child portal taking ownership while asynchronous work arrives.
  await page.evaluate(() => { const dialog = document.createElement('div'); dialog.id = 'test-child-dialog'; dialog.setAttribute('role', 'dialog'); document.body.append(dialog); });
  await expect(page.locator('[data-host-welcome-tour]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add guests', exact: true }).click();
  await page.getByLabel('Guest names or spreadsheet data').fill('Avery Lee');
  // Synthetic anchor fixture: intake replaces the launcher; guard focus is the subject here.
  await page.getByRole('heading', { name: 'Add guests', exact: true }).evaluate(el => { el.setAttribute('data-host-tour-anchor', 'rsvp'); });
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
  await expectVisibleWorkspaceFocus(page, page.getByRole('heading', { name: 'Add guests', exact: true }));
});


test('narrow tour keeps its measured target above the guidance panel', async ({ page }) => {
  await stubWelcome(page, 'dismissed');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${manager}?section=overview`);
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect.poll(async () => {
    const target = await page.locator('.host-welcome__target').boundingBox();
    const panel = await page.locator('.host-welcome__panel').boundingBox();
    return panel!.y - target!.y - target!.height;
  }).toBeGreaterThanOrEqual(12);
  await expect(page.locator('[data-host-tour-recommended-action]')).toBeInViewport({ ratio: 1 });
});


for (const { control, stepIndex } of [{ control: 'Escape', stepIndex: 1 }, { control: 'Skip tour', stepIndex: 1 }, { control: 'Close tour', stepIndex: 1 }, { control: 'Escape', stepIndex: 4 }]) {
  test(`later-step ${stepIndex + 1} ${control} restores the visible destination target`, async ({ page }) => {
    await stubWelcome(page, 'dismissed');
    await page.goto(`${manager}?section=overview`);
    await page.getByRole('button', { name: 'Tour event tools' }).click();
    for (let index = 0; index < stepIndex; index += 1) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.getByRole('heading', { name: titles[index + 1], exact: true })).toBeFocused();
    }
    if (control === 'Escape') await page.keyboard.press('Escape');
    else await page.getByRole('button', { name: control, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(stepIndex === 4 ? page.locator('[data-host-tour-anchor="exports"]') : page.getByRole('button', { name: 'Add guests', exact: true })).toBeFocused();
    await expect(page.locator('#root')).not.toHaveAttribute('inert');
  });
}

test('failed completion recovers after reload and retry remains completed after a manual exit', async ({ page }) => {
  await stubWelcome(page);
  let fail = true; let serverStatus = 'unseen'; const outcomes: string[] = [];
  await page.route(tourPath, async route => {
    if (route.request().method() === 'PATCH') {
      expect(route.request().headers()['x-candidary-tour-account-id']).toBe('host-a');
      outcomes.push(route.request().postDataJSON().status);
      if (fail && route.request().postDataJSON().status === 'completed') { await route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } }); return; }
      serverStatus = route.request().postDataJSON().status;
    }
    await route.fulfill({ json: { data: { accountId: 'host-a', tourKey: 'host-event-welcome', version: 1, status: serverStatus } } });
  });
  await page.goto(`${manager}?section=overview`);
  await expect(page.getByRole('heading', { name: 'Collect photos privately', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => outcomes).toEqual(['dismissed']);
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  for (let index = 0; index < titles.length; index += 1) {
    await expect(page.getByRole('heading', { name: titles[index], exact: true })).toBeFocused();
    await expect(page.getByText(`Step ${index + 1} of 6`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: index === 5 ? 'Finish' : 'Next', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Retry saving tour preference' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry saving tour preference' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => outcomes).toEqual(['dismissed', 'completed', 'completed']);
  await expect(page.getByRole('button', { name: 'Retry saving tour preference' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Retry saving tour preference' }).click();
  await expect(page.getByRole('button', { name: 'Retry saving tour preference' })).toHaveCount(0);
  await expect.poll(() => outcomes).toEqual(['dismissed', 'completed', 'completed', 'completed']);
});

test('onboarding-focus: committed Back supersedes a pending guarded step and focuses its destination', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One project owns pending navigation focus at the explicit 320px viewport.');
  await page.setViewportSize({ width: 320, height: 568 });
  await stubWelcome(page, 'dismissed');
  await page.goto(manager);
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await chooseManagerSection(page, 'Overview');
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: titles[1], exact: true })).toBeVisible();
  await page.evaluate(() => { const dialog = document.createElement('div'); dialog.id = 'test-child-dialog'; dialog.setAttribute('role', 'dialog'); document.body.append(dialog); });
  await expect(page.locator('[data-host-welcome-tour]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add guests', exact: true }).click();
  await page.getByLabel('Guest names or spreadsheet data').fill('Avery Lee');
  // Synthetic anchor fixture: intake replaces the launcher; guard focus is the subject here.
  await page.getByRole('heading', { name: 'Add guests', exact: true }).evaluate(el => { el.setAttribute('data-host-tour-anchor', 'rsvp'); });
  await page.evaluate(() => document.getElementById('test-child-dialog')?.remove());
  await expect(page.getByRole('heading', { name: titles[1], exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your pending work is not saved' })).toBeVisible();
  await page.goBack();
  // Browser POP uses the existing unsaved-work guard. The tour must honor the
  // destination only after the host authorizes that guarded navigation.
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose your next task', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/section=overview/);
  await expectVisibleWorkspaceFocus(page, page.locator('[data-host-tour-recommended-action]'));
  await page.screenshot({ path: 'output/playwright/onboarding-remediation-2026-10-11/task-2/pending-back-overview.png' });
});


// Real browser rectangles own placement evidence; unit tests only cover flow/recovery.
async function expectTourLayout(page: Page, anchor: Locator) {
  await expect(page.getByRole('button', { name: /^(Next|Finish)$/ })).toBeEnabled();
  await expect(anchor).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => {
    const target = await page.locator('.host-welcome__target').boundingBox();
    const actual = await anchor.boundingBox();
    return target && actual ? Math.max(Math.abs(target.x - actual.x), Math.abs(target.y - actual.y), Math.abs(target.width - actual.width), Math.abs(target.height - actual.height)) : 999;
  }).toBeLessThan(1);
  const panel = (await page.locator('.host-welcome__panel').boundingBox())!;
  const target = (await anchor.boundingBox())!;
  const nav = (await page.locator('.manager-nav').boundingBox())!;
  const intersects = (a: typeof panel, b: typeof panel) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  expect(intersects(panel, target), 'panel must leave the named target unobscured').toBe(false);
  expect(intersects(target, nav), 'target must clear navigation').toBe(false);
  expect(intersects(panel, nav), 'panel must clear navigation').toBe(false);
  const viewport = page.viewportSize()!;
  for (const box of [panel, target]) {
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  for (const button of await page.locator('.host-welcome__panel button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
  }
  await page.locator('.host-welcome__panel').evaluate(el => el.scrollTop = 0);
}

for (const size of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: '320', width: 320, height: 568 },
  { name: '375', width: 375, height: 667 },
  { name: 'desktop-text-200', width: 1440, height: 900 },
]) {
  test(`onboarding-layout: actual work controls remain visible at ${size.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Desktop project owns the explicit viewport matrix.');
    await stubWelcome(page, 'dismissed');
    // Confirm a genuinely pristine roster, including the historical roster probe.
    await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/rsvp/summary`, route => route.fulfill({ json: { data: { invitedCapacity: 0, namedInvitees: 0, plusOneCapacity: 0, attending: 0, declined: 0, awaitingResponse: 0, householdsResponded: 0, householdsAwaitingResponse: 0 } } }));
    await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/rsvp/households*`, route => route.fulfill({ json: { data: { households: [], nextCursor: null } } }));
    const mutations: string[] = [];
    page.on('request', r => { if (r.url().includes('/api/manage/') && !['GET', 'HEAD'].includes(r.method())) mutations.push(r.url()); });
    await page.setViewportSize(size);
    await page.goto(`${manager}?section=overview`);
    if (size.name === 'desktop-text-200') await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    await page.getByRole('button', { name: 'Tour event tools' }).click();
    for (let index = 0; index < titles.length; index++) {
      await expect(page.getByRole('heading', { name: titles[index], exact: true })).toBeFocused();
      const selectors = ['[data-host-tour-anchor="overview-task"]', '[data-host-tour-anchor="rsvp"]', '[data-host-tour-anchor="share-qr"]', '[data-host-tour-anchor="library"]', '[data-host-tour-anchor="exports"]', '[data-host-tour-anchor="settings"]'];
      await expect(page.getByRole('button', { name: /^(Next|Finish)$/ })).toBeEnabled();
      let anchor = page.locator(selectors[index]!);
      if (await page.locator('[data-host-welcome-tour]').getAttribute('data-compact-target') === 'true') {
        anchor = index === 0 ? page.locator('[data-host-tour-recommended-action]') : page.locator(`[data-host-tour-compact="${['overview-task', 'rsvp', 'share-qr', 'library', 'exports', 'settings'][index]}"]`);
      }
      await expectTourLayout(page, anchor);
      if (index === 1) {
        await expect(anchor).toHaveText('Add guests');
        await expect(anchor).toHaveAttribute('data-host-tour-roster', 'pristine');
      }
      if (index === 2) {
        await expect(anchor.locator('.link-card')).toHaveCount(1);
        if (await anchor.locator('.manager-qr').count()) await expect(anchor.locator('img')).toBeInViewport({ ratio: 1 });
        else await expect(page.locator('.host-welcome__panel')).toContainText('Close the tour to inspect the QR below');
      }
      if (index === 3) await expect(anchor).toHaveAttribute('aria-label', 'Gallery mode');
      if (index === 5) await expect(anchor).toContainText('Guest uploads');
      await page.screenshot({ path: `output/playwright/onboarding-remediation-2026-10-11/task-1/${testInfo.project.name}-${size.name}-step-${index + 1}.png` });
      await page.getByRole('button', { name: index === 5 ? 'Finish' : 'Next', exact: true }).click();
    }
    expect(mutations).toEqual([]);
  });
}

test('onboarding-layout: removing an anchor during resize clears it and Retry recovers its new bounds', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One project owns the resize recovery check.');
  await stubWelcome(page, 'dismissed');
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(`${manager}?section=overview`);
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: titles[1], exact: true })).toBeFocused();
  await page.evaluate(() => { document.querySelector<HTMLElement>('[data-host-tour-anchor="rsvp"]')!.hidden = true; });
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(page.locator('.host-welcome__target')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry step' })).toBeVisible();
  const missingPanel = (await page.locator('.host-welcome__panel').boundingBox())!;
  expect(missingPanel.y).toBeGreaterThanOrEqual(0);
  expect(missingPanel.y + missingPanel.height).toBeLessThanOrEqual(568);
  await page.getByRole('button', { name: 'Retry step' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Retry step' })).toBeInViewport({ ratio: 1 });
  await expect(page.locator('[data-host-tour-anchor="rsvp"]')).toHaveAttribute('data-host-tour-roster', 'review');
  await page.evaluate(() => { document.querySelector<HTMLElement>('[data-host-tour-anchor="rsvp"]')!.hidden = false; });
  await page.getByRole('button', { name: 'Retry step' }).click();
  await expectTourLayout(page, page.locator('[data-host-tour-anchor="rsvp"]'));
});

test('onboarding-layout: disabled guest entry highlights Guest uploads status without a resume action', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One project owns the synthetic disabled-state check.');
  await stubWelcome(page, 'dismissed');
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/entry`, route => route.fulfill({ json: { data: { eventLink: null, disabledAt: '2026-10-01T00:00:00.000Z' } } }));
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(`${manager}?section=overview`);
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expectTourLayout(page, page.locator('[data-host-tour-anchor="settings"]'));
  await expect(page.locator('[data-host-tour-anchor="settings"]')).toContainText('Guest uploads');
  await expect(page.locator('[data-host-tour-anchor="settings"] button')).toHaveCount(0);
});


async function expectVisibleWorkspaceFocus(page: Page, target: Locator) {
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport({ ratio: 1 });
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement as HTMLElement;
    const box = active.getBoundingClientRect();
    const nav = document.querySelector<HTMLElement>('.manager-nav')!.getBoundingClientRect();
    return active !== document.body && !!active.closest('main') && box.width > 0 && box.height > 0
      && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
      && !(box.left < nav.right && box.right > nav.left && box.top < nav.bottom && box.bottom > nav.top);
  })).toBe(true);
}

for (const size of [{ width: 320, height: 568 }, { width: 375, height: 667 }]) {
  for (const control of ['Escape', 'Close tour', 'Skip tour']) {
    test(`onboarding-focus: ${control} restores offscreen and removed invokers at ${size.width}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'Desktop project owns both explicit phone widths; mobile copy would duplicate the matrix.');
      await stubWelcome(page, 'dismissed');
      const mutations: string[] = [];
      page.on('request', r => { if (r.url().includes('/api/manage/') && !['GET', 'HEAD'].includes(r.method())) mutations.push(r.url()); });
      await page.setViewportSize(size);
      await page.goto(`${manager}?section=overview`);
      const invoker = page.getByRole('button', { name: 'Tour event tools' });
      // Keep the actual React control connected, below the measured Overview target.
      await invoker.evaluate(el => { el.style.marginTop = '1400px'; });
      await invoker.click();
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
      expect((await invoker.boundingBox())!.y).toBeGreaterThan(size.height);
      if (control === 'Escape') await page.keyboard.press('Escape');
      else await page.getByRole('button', { name: control, exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expectVisibleWorkspaceFocus(page, invoker);
      await page.screenshot({ path: `output/playwright/onboarding-remediation-2026-10-11/task-2/${size.width}-${control.replaceAll(' ', '-')}-connected.png` });
      // A real section change removes the Overview invoker; RSVP must own focus.
      await invoker.evaluate(el => { el.style.marginTop = ''; });
      await invoker.click();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.getByRole('heading', { name: titles[1], exact: true })).toBeFocused();
      await expect(invoker).toHaveCount(0);
      if (control === 'Escape') await page.keyboard.press('Escape');
      else await page.getByRole('button', { name: control, exact: true }).click();
      await expectVisibleWorkspaceFocus(page, page.getByRole('button', { name: 'Add guests', exact: true }));
      await page.screenshot({ path: `output/playwright/onboarding-remediation-2026-10-11/task-2/${size.width}-${control.replaceAll(' ', '-')}-removed.png` });
      expect(mutations).toEqual([]);
    });
  }
}

test('onboarding-focus: tools Finish focuses the Overview action without activating it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One project owns tools completion at the explicit 320px viewport.');
  await stubWelcome(page, 'dismissed');
  const mutations: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/manage/') && !['GET', 'HEAD'].includes(r.method())) mutations.push(r.url()); });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${manager}?section=overview`);
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectVisibleWorkspaceFocus(page, page.locator('[data-host-tour-recommended-action]'));
  await expect(page).toHaveURL(/section=overview/);
  expect(mutations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/onboarding-remediation-2026-10-11/task-2/finish-overview.png' });
});


test('onboarding-focus: automatic first-step exit focuses the Overview action instead of BODY', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One project owns the explicit 320px automatic-launch focus check.');
  await stubWelcome(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${manager}?section=overview`);
  await expect(page.getByRole('heading', { name: 'Collect photos privately', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectVisibleWorkspaceFocus(page, page.locator('[data-host-tour-recommended-action]'));
  await page.screenshot({ path: 'output/playwright/onboarding-remediation-2026-10-11/task-2/automatic-overview.png' });
});

for (const size of [{ width: 1440, height: 900 }, { width: 320, height: 568 }, { width: 375, height: 667 }]) {
  test(`onboarding-context: one-screen intro commits Library at ${size.width}px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Explicit viewport matrix has one project owner.');
    await page.setViewportSize(size);
    const writes = await stubWelcome(page);
    const mutations: string[] = [];
    page.on('request', r => { if (r.url().includes('/api/manage/') && r.method() !== 'GET') mutations.push(r.url()); });
    await page.goto(`${manager}?section=overview`);
    await expect(page.getByRole('heading', { name: 'Collect photos privately' })).toBeFocused();
    await expect(page.getByText('Step 1 of 6', { exact: true })).toHaveCount(0);
    const primary = page.getByRole('button', { name: 'Go to Library', exact: true });
    await expect(primary).toBeEnabled();
    await primary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `output/playwright/onboarding-remediation-2026-10-11/task-3/intro-${size.width}.png` });
    await primary.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectVisibleWorkspaceFocus(page, page.getByRole('group', { name: 'Gallery mode', exact: true }).getByRole('button', { name: 'Library, 1', exact: true }));
    await expect.poll(() => writes).toEqual(['completed']);
    expect(mutations).toEqual([]);
  });
}

test('onboarding-context: ended disabled access hands off to Exports without preparation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One project owns the retrieval contract.');
  const writes = await stubWelcome(page, 'unseen', true);
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/lifecycle`, route => route.fulfill({ json: { data: { phase: 'waiting', rsvpState: 'closed', photoIntakeState: 'paused', guestAccessEnded: true, entryDisabled: true, lifecycleRecheckAfterMs: null } } }));
  const mutations: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/manage/') && r.method() !== 'GET') mutations.push(r.url()); });
  await page.goto(`${manager}?section=overview`);
  await expect(page.locator('.host-welcome__panel')).toContainText('cannot be replaced');
  await page.getByRole('button', { name: 'Go to Exports', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Exports', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.gallery-export-tools :focus')).toHaveCount(1);
  await expect.poll(() => writes).toEqual(['completed']);
  expect(mutations).toEqual([]);
});

test('onboarding-context: tools refresh phase and entry while outside Overview', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One project owns live context.');
  await stubWelcome(page, 'dismissed');
  let ended = false; let reads = 0;
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/lifecycle`, route => { reads += 1; return route.fulfill({ json: { data: { phase: 'photos-primary', rsvpState: 'disabled', photoIntakeState: 'open', guestAccessEnded: ended, entryDisabled: ended, lifecycleRecheckAfterMs: null } } }); });
  await page.goto(`${manager}?section=overview`);
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Step 3 of 6', { exact: true })).toBeVisible();
  ended = true;
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/entry`, route => route.fulfill({ json: { data: { eventLink: null, disabledAt: '2026-10-11T00:00:00Z' } } }));
  const previousReads = reads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.host-welcome__panel')).toContainText('cannot be replaced');
  await expect(page.getByText('Step 3 of 6', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect(page.locator('[data-host-tour-anchor="share-status"]')).toContainText('cannot be replaced');
  expect(reads).toBe(previousReads + 1);
  await page.screenshot({ path: 'output/playwright/onboarding-remediation-2026-10-11/task-3/live-ended-share.png' });
});


// CDP supplies the actual browser AX tree; DOM attributes and axe alone do not
// prove a computed accessible description or inert background exclusion.
async function welcomeAX(page: Page, expectedName: string, progress: string, body: string) {
  const session = await page.context().newCDPSession(page);
  const tree = await session.send('Accessibility.getFullAXTree');
  await session.detach();
  const exposed = tree.nodes.filter(node => !node.ignored);
  const dialog = exposed.find(node => node.role?.value === 'dialog');
  expect(dialog?.name?.value).toBe(expectedName);
  expect(dialog?.properties?.find(property => property.name === 'modal')?.value.value).toBe(true);
  expect(dialog?.description?.value).toBe(`${progress} ${body}`);
  const heading = exposed.find(node => node.role?.value === 'heading' && node.name?.value === expectedName);
  expect(heading?.description?.value).toBe(progress);
  expect(heading?.properties?.find(property => property.name === 'focused')?.value.value).toBe(true);
  const buttons = exposed.filter(node => node.role?.value === 'button').map(node => node.name?.value);
  expect(buttons).not.toContain('Tour event tools');
  expect(buttons).not.toContain('Show me how to collect photos');
  expect(buttons).not.toContain('Copy event link');
  // Only controls belonging to the active dialog may be exposed as buttons.
  expect(buttons.sort()).toEqual((await page.getByRole('dialog').getByRole('button').allTextContents()).map(text => text.trim()).map(text => text || 'Close tour').sort());
  await expect(page.locator('#root')).toHaveAttribute('inert');
  return tree;
}

for (const size of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`onboarding-a11y: dialog context, all six steps and keyboard ring at ${size.width}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'One project owns this explicit accessibility viewport matrix.');
    await page.setViewportSize(size);
    await stubWelcome(page, 'dismissed');
    const mutations: string[] = [];
    page.on('request', request => { if (request.url().includes('/api/manage/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.url()); });
    await page.goto(`${manager}?section=overview`);
    const introInvoker = page.getByRole('button', { name: 'Show me how to collect photos' });
    await introInvoker.click();
    const dialog = page.getByRole('dialog');
    await expect(page.getByRole('heading', { name: 'Collect photos privately', exact: true })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Go to Library' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Go to Library' })).toBeInViewport({ ratio: 1 });
    const introBody = await dialog.locator('#host-welcome-description').innerText();
    expect(introBody).toContain('Photo delivery is open.');
    expect(introBody).toContain('Open Library: Photo delivery is open. View the originals delivered privately to you in Library.');
    const captures = [await welcomeAX(page, 'Collect photos privately', 'Introduction', introBody)];
    await mkdir('output/playwright/onboarding-remediation-2026-10-11/task-6', { recursive: true });
    await page.screenshot({ path: `output/playwright/onboarding-remediation-2026-10-11/task-6/intro-${size.width}.png` });
    await expect(dialog.getByText(/Step \d of/)).toHaveCount(0);
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Go to Library' })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Close tour' })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Skip tour' })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Go to Library' })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Close tour' })).toBeFocused();
    expect((await new AxeBuilder({ page }).include('.host-welcome').analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expectVisibleWorkspaceFocus(page, introInvoker);
    await page.getByRole('button', { name: 'Tour event tools' }).click();
    for (let index = 0; index < titles.length; index += 1) {
      const title = page.getByRole('heading', { name: titles[index], exact: true });
      await expect(title).toBeFocused();
      const next = dialog.getByRole('button', { name: index === 5 ? 'Finish' : 'Next', exact: true });
      await expect(next).toBeEnabled();
      const body = await dialog.locator('#host-welcome-description').innerText();
      captures.push(await welcomeAX(page, titles[index]!, `Step ${index + 1} of 6`, body));
      await page.keyboard.press('Shift+Tab'); await expect(next).toBeFocused();
      await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Close tour' })).toBeFocused();
      await page.keyboard.press('Shift+Tab'); await expect(next).toBeFocused();
      if (index === 1) {
        await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('heading', { name: titles[0], exact: true })).toBeFocused();
        await expect(dialog).toHaveAccessibleDescription(/^Step 1 of 6 /);
        await dialog.getByRole('button', { name: 'Next', exact: true }).focus();
        await page.keyboard.press('Enter'); await expect(title).toBeFocused();
        await expect(next).toBeEnabled(); await next.focus();
      }
      if (index < 5) await page.keyboard.press('Enter');
    }
    expect((await new AxeBuilder({ page }).include('.host-welcome').analyze()).violations).toEqual([]);
    const captureRoot = 'output/playwright/onboarding-remediation-2026-10-11/task-6';
    await mkdir(captureRoot, { recursive: true });
    await writeFile(`${captureRoot}/ax-${size.width}.json`, JSON.stringify(captures, null, 2));
    await page.screenshot({ path: `${captureRoot}/tools-settings-${size.width}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Settings restores its explicit focusable Guest uploads status region.
    const statusRegion = page.locator('[data-host-tour-compact="settings"]');
    await expect(statusRegion).toContainText('Guest uploads are open.');
    await expectVisibleWorkspaceFocus(page, statusRegion);
    expect(mutations).toEqual([]);
  });
}

test('onboarding-a11y: failed-save replay and missing target expose one recoverable status', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One project owns the status recovery case at 375px.');
  await page.setViewportSize({ width: 375, height: 667 });
  await stubWelcome(page);
  let fail = true;
  await page.route(tourPath, route => route.request().method() === 'PATCH' && fail
    ? route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } })
    : route.fulfill({ json: { data: { accountId: 'host-a', tourKey: 'host-event-welcome', version: 1, status: 'unseen' } } }));
  await page.goto(`${manager}?section=overview`);
  await expect(page.getByRole('heading', { name: 'Collect photos privately', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Retry saving tour preference' })).toBeVisible();
  await expect(page.locator('.host-welcome-save[role="status"]')).toContainText('Your tour preference could not be saved.');
  await page.getByRole('button', { name: 'Tour event tools' }).click();
  const dialog = page.getByRole('dialog');
  const title = dialog.getByRole('heading', { name: 'Your next task', exact: true });
  await expect(title).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect(page.locator('.host-welcome-save')).toHaveCount(0);
  await expect(dialog.getByRole('status')).toHaveCount(1);
  await expect(dialog.getByRole('status')).toContainText('Your tour preference could not be saved.');
  await page.locator('[data-host-tour-anchor="overview-task"]').evaluate(element => element.setAttribute('hidden', ''));
  await expect(dialog.getByRole('button', { name: 'Retry step' })).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveCount(1);
  await expect(dialog.getByRole('status')).toContainText('This part of the page is not available yet.');
  await expect(dialog.getByRole('status')).toContainText('Your tour preference could not be saved.');
  await expect(title).toBeFocused();
  const statusTree = await welcomeAX(page, 'Your next task', 'Step 1 of 6', await dialog.locator('#host-welcome-description').innerText());
  const exposed = statusTree.nodes.filter(node => !node.ignored);
  const statuses = exposed.filter(node => node.role?.value === 'status');
  expect(statuses).toHaveLength(1);
  expect(statuses[0]?.properties?.find(property => property.name === 'live')?.value.value).toBe('polite');
  const texts = exposed.filter(node => node.role?.value === 'StaticText').map(node => String(node.name?.value));
  expect(texts.filter(text => text.includes('Your tour preference could not be saved.'))).toHaveLength(1);
  expect(texts.filter(text => text.includes('This part of the page is not available yet.'))).toHaveLength(1);
  await mkdir('output/playwright/onboarding-remediation-2026-10-11/task-6', { recursive: true });
  await writeFile('output/playwright/onboarding-remediation-2026-10-11/task-6/ax-status.json', JSON.stringify(statusTree, null, 2));
  await page.screenshot({ path: 'output/playwright/onboarding-remediation-2026-10-11/task-6/status-375.png' });
  expect((await new AxeBuilder({ page }).include('.host-welcome').analyze()).violations).toEqual([]);
  await page.locator('[data-host-tour-anchor="overview-task"]').evaluate(element => element.removeAttribute('hidden'));
  await dialog.getByRole('button', { name: 'Retry step' }).focus(); await page.keyboard.press('Enter');
  await expect(title).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  fail = false;
  await dialog.getByRole('button', { name: 'Retry saving tour preference' }).focus(); await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Retry saving tour preference' })).toHaveCount(0);
  await expect(dialog.getByRole('status')).toHaveCount(1);
  await expect(dialog.getByRole('status')).toHaveText('');
  // Removing the successful retry control must keep focus in the dialog.
  await expect(title).toBeFocused();
  await page.keyboard.press('Escape');
  await expectVisibleWorkspaceFocus(page, page.getByRole('button', { name: 'Tour event tools' }));
});

// Recovery fixtures deliberately seed actual React inputs while the guide owns
// inert background. This models a pre-existing/asynchronous draft; it does not
// claim a user can edit an inert control. No fake dialog or replacement anchor.
async function seedReactInput(input: Locator, value: string) {
  await input.evaluate((element, next) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function recoveryTools(page: Page, step: number) {
  await stubWelcome(page, 'dismissed');
  await page.goto(`${manager}?section=overview`);
  await page.getByRole('button', { name: 'Tour event tools', exact: true }).click();
  for (let index = 0; index < step; index += 1) {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: titles[index + 1], exact: true })).toBeFocused();
  }
}
async function seedGuestDraft(page: Page) {
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await page.locator('[data-host-tour-anchor="rsvp"]').evaluate((element: HTMLButtonElement) => element.click());
  await seedReactInput(page.locator('textarea').filter({ visible: true }), 'Avery Lee');
  await expect(page.getByRole('button', { name: 'Retry step', exact: true })).toBeVisible();
}
for (const destination of ['stay-then-leave', 'external-supersedes'] as const) {
  test(`onboarding-recovery: actual guest-list guard ${destination}`, async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'One owner for this explicit 375px recovery fixture.');
    await page.setViewportSize({ width: 375, height: 667 });
    await recoveryTools(page, 1);
    const mutations: string[] = [];
    page.on('request', request => { if (request.url().includes('/api/manage/') && request.method() !== 'GET') mutations.push(request.url()); });
    await seedGuestDraft(page);
    await page.locator('.manager-nav button').filter({ hasText: /^Share$/ }).evaluate((element: HTMLButtonElement) => element.click());
    await expect(page.getByRole('heading', { name: 'Your pending work is not saved' })).toBeVisible();
    await expect(page.locator('[data-host-welcome-tour]')).toHaveCount(0);
    await expect(page.locator('#root')).not.toHaveAttribute('inert');
    if (destination === 'stay-then-leave') {
      await page.getByRole('button', { name: 'Stay', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Your guest list', exact: true })).toBeFocused();
      await expect(page.locator('textarea').filter({ visible: true })).toHaveValue('Avery Lee');
      await page.locator('.manager-nav button').filter({ hasText: /^Share$/ }).evaluate((element: HTMLButtonElement) => element.click());
      await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
      await expect(page).toHaveURL(/section=share/);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expectVisibleWorkspaceFocus(page, page.locator('[data-host-tour-anchor="share-qr"] code').first());
      await chooseManagerSection(page, 'RSVP');
      await expect(page.getByRole('button', { name: 'Add guests', exact: true })).toBeVisible();
    } else {
      await page.goBack();
      await expect(page.getByRole('heading', { name: 'Your pending work is not saved' })).toBeVisible();
      await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
      await expect(page).toHaveURL(/section=overview/);
      await expect(page.locator('[data-host-welcome-tour]')).toHaveCount(0);
      await expectVisibleWorkspaceFocus(page, page.locator('[data-host-tour-recommended-action]'));
    }
    expect(mutations).toEqual([]);
  });
}

test('onboarding-recovery: real upload dialog temporarily owns the screen', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Single actual app-dialog ownership fixture.');
  await recoveryTools(page, 3);
  // Synthetic invocation models a competing app modal; this is the actual
  // upload launcher and ModalSurface, with no file selected or upload request.
  const mutations: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/manage/') && request.method() !== 'GET') mutations.push(request.url()); });
  await page.locator('button').filter({ hasText: /^Add photos$/ }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.locator('[data-host-welcome-tour]')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('Add photos');
  await expect(page.locator('#root')).toHaveAttribute('inert');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Your delivered photos', exact: true })).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Escape');
  expect(mutations).toEqual([]);
});

for (const state of ['valid', 'invalid', 'failed'] as const) {
  test(`onboarding-recovery: Settings ${state} draft retains normal save and refusal semantics`, async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'One owner for each actual Settings guard state.');
    await recoveryTools(page, 5);
    const writes: unknown[] = [];
    await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}/settings`, async route => {
      writes.push(route.request().postDataJSON());
      await route.fulfill(state === 'failed' ? { status: 503, json: { code: 'UNAVAILABLE', message: 'Synthetic save failure' } } : { json: { data: { event: { ...EVENT_FIXTURE, ...route.request().postDataJSON() } } } });
    });
    const value = state === 'invalid' ? '' : 'Synthetic host draft';
    await seedReactInput(page.locator('input').filter({ visible: true }).first(), value);
    if (state !== 'invalid') await expect.poll(() => writes.length).toBe(1);
    if (state === 'valid') {
      await page.getByRole('button', { name: 'Finish', exact: true }).click();
      await expect(page).toHaveURL(/section=overview/);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await chooseManagerSection(page, 'Settings');
      await expect(page.getByLabel('Event name', { exact: true })).toHaveValue(value);
      expect(writes).toEqual([expect.objectContaining({ name: value })]);
    } else {
      // Synthetic external router intent while guidance is open, using the real
      // site link and blocker; in-app workspaces intentionally retain editors.
      await page.locator('a[href="/"]').first().evaluate((element: HTMLAnchorElement) => element.click());
      await expect(page.getByRole('button', { name: 'Stay and fix settings' })).toBeVisible();
      await expect(page.locator('[data-host-welcome-tour]')).toHaveCount(0);
      await page.getByRole('button', { name: 'Stay and fix settings' }).click();
      await expect(page).toHaveURL(/section=settings/);
      if (await page.locator('[data-host-welcome-tour]').count()) await page.keyboard.press('Escape');
      await expect(page.getByLabel('Event name', { exact: true })).toHaveValue(value);
      await chooseManagerSection(page, 'Overview');
      await expect(page.getByRole('button', { name: 'Stay and fix settings' })).toBeVisible();
      await expect(page).toHaveURL(/section=settings/);
      await page.getByRole('button', { name: 'Stay and fix settings' }).click();
      await expect(page.getByLabel('Event name', { exact: true })).toHaveValue(value);
      expect(writes.length).toBe(state === 'invalid' ? 0 : 1);
    }
  });
}

test('onboarding-integration: welcome create receipt intro first control reload and tools replay', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Single complete integration fixture at 375px.');
  await page.setViewportSize({ width: 375, height: 667 });
  await stubWelcome(page);
  await page.route(`**/api/manage/events/${EVENT_FIXTURE.id}`, route => route.fulfill({ json: { data: { event: { ...EVENT_FIXTURE, storedMediaCount: 0 } } } }));
  await page.route('**/api/host/session', route => route.fulfill({ json: { data: { account: { id: 'host-a', email: 'synthetic@example.test', emailVerified: true }, events: [] } } }));
  let status = 'unseen'; const preferenceWrites: string[] = []; const eventWrites: string[] = [];
  await page.route(tourPath, async route => {
    if (route.request().method() === 'PATCH') { status = route.request().postDataJSON().status; preferenceWrites.push(status); }
    await route.fulfill({ json: { data: { accountId: 'host-a', tourKey: 'host-event-welcome', version: 1, status } } });
  });
  page.on('request', request => { if (/\/api\/(events|manage\/)/.test(request.url()) && request.method() !== 'GET') eventWrites.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  await page.route('**/api/events', async route => {
    expect(route.request().postDataJSON()).toMatchObject({ name: 'Synthetic integration celebration', eventDate: '2026-12-19', eventStartTime: '17:00', eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-12-05' });
    await route.fulfill({ status: 201, json: { data: { event: EVENT_FIXTURE, eventLink: 'http://127.0.0.1:4175/join#synthetic', managementLink: 'http://127.0.0.1:4175/manage/synthetic', csrfToken: 'synthetic', savedToAccount: true } } });
  });
  await page.goto('/');
  await page.getByRole('link', { name: 'Create your event', exact: true }).first().click();
  for (const [label, value] of Object.entries({ 'Event name': 'Synthetic integration celebration', 'Event date': '2026-12-19', 'Event start time': '17:00', 'Event time zone': 'America/Chicago', 'RSVP deadline': '2026-12-05', 'Welcome message': 'Share the moments you caught.' })) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Create private event', exact: true }).click();
  await expect(page.getByText('Saved to your account', { exact: true })).toBeVisible();
  expect(eventWrites).toEqual(['POST /api/events']);
  await page.getByRole('link', { name: 'Continue to your event', exact: true }).click();
  await expect(page).toHaveURL(/section=overview/);
  await expect(page.getByRole('heading', { name: 'Collect photos privately', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Go to Share', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectVisibleWorkspaceFocus(page, page.locator('[data-host-tour-anchor="share-qr"] code').first());
  expect(eventWrites).toEqual(['POST /api/events']);
  await expect.poll(() => preferenceWrites).toEqual(['completed']);
  // Copy is a deliberate host action after dismissal, never guide activation.
  await page.getByRole('button', { name: 'Copy event link', exact: true }).click();
  await page.reload();
  await expect(page).toHaveURL(/section=share/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await chooseManagerSection(page, 'Overview');
  await page.getByRole('button', { name: 'Tour event tools', exact: true }).click();
  await expect(page.getByText('Step 1 of 6', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(eventWrites).toEqual(['POST /api/events']);
  expect(preferenceWrites).toEqual(['completed']);
});

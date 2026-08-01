import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import type { RsvpSummary } from '../../shared/contracts';
import {
  EVENT_FIXTURE,
  RSVP_HOUSEHOLD_DETAIL_FIXTURE,
  stubManagerRoutes,
  stubRsvpRosterBatchRoutes,
} from './fixtures/routes';
import { measureDocument, measureTarget, measureViewportEscapes } from './helpers/geometry';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOUCH_MINIMUM = 44;
const EMPTY_SUMMARY: RsvpSummary = {
  invitedCapacity: 0,
  namedInvitees: 0,
  plusOneCapacity: 0,
  attending: 0,
  declined: 0,
  awaitingResponse: 0,
  householdsResponded: 0,
  householdsAwaitingResponse: 0,
};

async function expectContained(page: Page, scope: Locator, label: string) {
  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth, `${label} document width`)
    .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  expect(await measureViewportEscapes(scope), `${label} viewport escapes`).toEqual([]);
}

async function expectTouchTargets(scope: Locator, selector: string, label: string) {
  const controls = scope.locator(selector);
  const rendered = await controls.count();
  expect(rendered, `${label} rendered controls`).toBeGreaterThan(0);
  for (let index = 0; index < rendered; index += 1) {
    const target = controls.nth(index);
    if (!await target.isVisible()) continue;
    const size = await measureTarget(target);
    expect(size.width, `${label} ${index + 1} width`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    expect(size.height, `${label} ${index + 1} height`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
  }
}

async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .options({ rules: { 'target-size': { enabled: true } } })
    .analyze();
  expect(
    results.violations.flatMap(({ id, nodes }) => nodes.map((node) => ({
      id,
      target: node.target,
      why: [...node.any, ...node.all].map(({ message }) => message),
    }))),
    `${label} accessibility violations`,
  ).toEqual([]);
}

async function chooseByKeyboard(select: Locator, arrowDowns: number) {
  await select.focus();
  await select.press('Home');
  for (let index = 0; index < arrowDowns; index += 1) await select.press('ArrowDown');
  await select.press('Tab');
}

test('pristine clipboard paste groups invitations and commits the canonical batch', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    rsvp: {
      summary: EMPTY_SUMMARY,
      households: { households: [], nextCursor: null },
    },
  });
  const requests = await stubRsvpRosterBatchRoutes(page, EVENT_FIXTURE.id, {
    initialHouseholds: 0,
    initialInvitedCapacity: 0,
  });

  await page.goto(`/manage/event/${EVENT_FIXTURE.id}?section=rsvp`);
  await page.context().grantPermissions(
    ['clipboard-read', 'clipboard-write'],
    { origin: new URL(page.url()).origin },
  );
  await expect(page.getByRole('heading', { name: 'Start your guest list' })).toBeVisible();
  await expect(page.getByLabel('Filter guest list')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add guests' }).click();

  const source = 'Avery Lee\nJordan Lee\nCasey Stone';
  await page.evaluate((value) => navigator.clipboard.writeText(value), source);
  const sourceField = page.getByLabel('Guest names or spreadsheet data');
  await sourceField.focus();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(sourceField).toHaveValue(source);
  await expect(page.getByText('Detected:')).toContainText('plain names');
  await expectTouchTargets(page.locator('.guest-list-capture'), 'fieldset > label', 'format choices');
  await expectContained(page, page.locator('.guest-list-workspace'), 'clipboard capture at 390');
  await expectAccessible(page, 'guest-list capture');

  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Organize invitations' })).toBeVisible();
  for (const name of ['Avery Lee', 'Jordan Lee']) {
    const checkbox = page.getByRole('checkbox', { name });
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
  }
  const group = page.getByRole('button', { name: 'Group as one invitation' });
  await group.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('list', { name: 'Staged invitations' })).toContainText('Avery Lee and Jordan Lee');
  await expect(page.locator('.guest-list-grouping p').filter({
    hasText: 'Will become individual invitations:',
  })).toContainText('Casey Stone');
  await expectAccessible(page, 'guest-list grouping');

  await page.getByRole('button', { name: 'Continue to details' }).click();
  await page.getByRole('button', { name: 'Review guests' }).click();
  await expect(page.getByRole('heading', { name: 'Review guest list' })).toBeVisible();
  await expect(page.getByText('Automatic individual invitations: Casey Stone')).toBeVisible();
  await expect.poll(() => requests.previews.length).toBe(1);

  const previewRequest = requests.previews[0]!;
  expect(Object.keys(previewRequest).sort()).toEqual(['batch', 'expectedRosterVersion']);
  expect(Object.keys(previewRequest.batch).sort()).toEqual(['appends', 'creates']);
  expect(previewRequest.batch.appends).toEqual([]);
  expect(previewRequest.batch.creates).toHaveLength(2);
  expect(previewRequest.batch.creates.flatMap(({ namedInvitees }) => namedInvitees)).toHaveLength(3);
  for (const create of previewRequest.batch.creates) {
    expect(create.clientHouseholdId).toMatch(UUID);
    for (const invitee of create.namedInvitees) expect(invitee.clientInviteeId).toMatch(UUID);
  }

  await expectAccessible(page, 'guest-list review');
  await page.getByRole('button', { name: 'Add 3 guests across 2 households' }).click();
  await expect(page.getByRole('heading', { name: 'Guests added' })).toBeVisible();
  await expect(page.getByText('2 households created')).toBeVisible();
  await expect(page.getByText('3 named guests added')).toBeVisible();
  await expect.poll(() => requests.commits.length).toBe(1);
  await expectContained(page, page.locator('.guest-list-workspace'), 'guest-list receipt at 390');

  const commitRequest = requests.commits[0]!;
  const reviewed = requests.previewResponses[0]!;
  expect(commitRequest).toEqual({
    canonicalBatch: reviewed.canonicalBatch,
    previewDigest: reviewed.previewDigest,
    expectedRosterVersion: reviewed.rosterVersion,
    idempotencyKey: expect.stringMatching(UUID),
  });
  expect(commitRequest.canonicalBatch.creates.map(({ clientHouseholdId }) => clientHouseholdId))
    .toEqual(previewRequest.batch.creates.map(({ clientHouseholdId }) => clientHouseholdId));
  expect(commitRequest.canonicalBatch.creates.every(({ householdKey }) => householdKey.provenance === 'generated'))
    .toBe(true);
  expect(commitRequest.idempotencyKey).toMatch(UUID);
  expect(commitRequest.previewDigest).toHaveLength(64);
  await expectAccessible(page, 'guest-list receipt');
});

test('file quick-add maps columns, recovers a linked issue, and opens the updated household', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  const longIssue = 'The staged guest name needs attention before this addition can be committed. '.repeat(6);
  const requests = await stubRsvpRosterBatchRoutes(page, EVENT_FIXTURE.id, {
    initialHouseholds: 1,
    initialInvitedCapacity: 3,
    preview: ({ attempt, request, defaultResponse }) => {
      if (attempt !== 1) return defaultResponse;
      const append = request.batch.appends[0]!;
      const invitee = append.namedInvitees[0]!;
      return {
        ...defaultResponse,
        issues: [{
          clientHouseholdId: append.clientHouseholdId,
          clientInviteeId: invitee.clientInviteeId,
          field: 'namedInvitees.displayName',
          code: 'invitee_name_invalid',
          message: longIssue,
          severity: 'blocking',
        }],
        canCommit: false,
      };
    },
  });

  await page.goto(`/manage/event/${EVENT_FIXTURE.id}?section=rsvp`);
  await page.getByRole('button', { name: 'Add guests' }).click();
  await page.getByLabel('Choose guest-list file').setInputFiles({
    name: 'later-guests.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Guest,Invitation,Slots\nRiley Quinn,Friends,1'),
  });
  await expect(page.getByText('Detected:')).toContainText('structured data');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await chooseByKeyboard(page.getByLabel('Guest name (required)'), 1);
  const householdMapping = page.getByRole('combobox', { name: 'Household', exact: true });
  await chooseByKeyboard(householdMapping, 2);
  await chooseByKeyboard(page.getByLabel('Plus-one slots'), 3);
  await expect(page.getByLabel('Guest name (required)')).toHaveValue('0');
  await expect(householdMapping).toHaveValue('1');
  await expect(page.getByLabel('Plus-one slots')).toHaveValue('2');
  await expectContained(page, page.locator('.guest-list-workspace'), 'column mapping at 320');
  await page.setViewportSize({ width: 320, height: 1400 });
  await expectAccessible(page, 'guest-list column mapping');
  await page.setViewportSize({ width: 320, height: 900 });

  const targetSearch = page.getByLabel('Search households');
  await targetSearch.focus();
  await page.keyboard.type('Morgan');
  const targetSelect = page.getByLabel('Existing household target');
  await expect(targetSelect.locator('option')).toHaveCount(2);
  await chooseByKeyboard(targetSelect, 1);
  await expect(targetSelect).toHaveValue(RSVP_HOUSEHOLD_DETAIL_FIXTURE.id);
  await expect(page.getByText(/Will become individual invitations:/u)).toHaveCount(0);

  await page.getByRole('button', { name: 'Continue to details' }).click();
  await chooseByKeyboard(page.getByLabel('Attendance for Riley Quinn'), 1);
  await chooseByKeyboard(page.getByLabel('Attendance for new plus-one 1'), 1);
  await page.getByLabel('Name for attending plus-one 1').fill('Sam Rivera');
  await expectContained(page, page.locator('.guest-list-workspace'), 'invitation details at 320');
  await expectAccessible(page, 'guest-list invitation details');
  await page.getByRole('button', { name: 'Review guests' }).click();

  const issueLink = page.getByRole('link', { name: /Fix needed:/u });
  await expect(issueLink).toBeVisible();
  await expect(issueLink).toBeFocused();
  for (const width of [320, 390, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await expectContained(page, page.locator('.guest-list-workspace'), `blocking review at ${width}`);
    await expectTouchTargets(page.locator('.guest-list-workspace'), 'button, a.text-button', `review actions at ${width}`);
  }
  await expectAccessible(page, 'guest-list blocking review');

  await issueLink.press('Enter');
  await expect(page.getByRole('heading', { name: 'Invitation details' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Guest list review issues' })).toBeVisible();
  const firstAppend = requests.previews[0]!.batch.appends[0]!;
  const firstInvitee = firstAppend.namedInvitees[0]!;
  await expect(page.locator(`#guest-list-field-${firstInvitee.clientInviteeId}-namedInvitees\\.displayName`)).toBeFocused();
  await page.getByLabel('Guest name').fill('Riley Quinn-Smith');
  await page.getByRole('button', { name: 'Review guests' }).click();
  await expect(page.getByRole('heading', { name: 'Review guest list' })).toBeVisible();
  await expect(page.getByText('Target existing household:')).toContainText('The Morgan household');
  await expect(page.getByText(/Automatic individual invitations:/u)).toHaveCount(0);
  await expect.poll(() => requests.previews.length).toBe(2);

  const secondAppend = requests.previews[1]!.batch.appends[0]!;
  expect(requests.previews[1]!.batch.creates).toEqual([]);
  expect(secondAppend.clientHouseholdId).toBe(firstAppend.clientHouseholdId);
  expect(secondAppend.householdId).toBe(RSVP_HOUSEHOLD_DETAIL_FIXTURE.id);
  expect(secondAppend.namedInvitees).toEqual([{
    clientInviteeId: firstInvitee.clientInviteeId,
    displayName: 'Riley Quinn-Smith',
    attendance: 'attending',
  }]);
  expect(secondAppend.newPlusOneResponses).toEqual([{
    clientInviteeId: expect.stringMatching(UUID),
    attendance: 'attending',
    displayName: 'Sam Rivera',
  }]);

  await page.getByRole('button', { name: 'Add 2 guests across 1 household' }).click();
  await expect(page.getByRole('heading', { name: 'Guests added' })).toBeVisible();
  await expect(page.getByText('1 household updated')).toBeVisible();
  await expect.poll(() => requests.commits.length).toBe(1);
  await page.getByRole('button', { name: 'Open The Morgan household' }).click();
  await expect(page.getByRole('heading', { name: 'The Morgan household' })).toBeVisible();
});

test('one pending-work prompt guards destinations, SPA links, and Settings repair', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Event name', exact: true }).fill('');
  const settingsNotice = page.getByRole('region', { name: 'Unsaved settings' });
  await expect(settingsNotice).toBeVisible();

  await page.getByRole('button', { name: 'RSVP' }).click();
  await expect(page.getByRole('heading', { name: 'Guest list and RSVPs' })).toBeVisible();
  await page.getByRole('button', { name: 'Add guests' }).click();
  const source = page.getByLabel('Guest names or spreadsheet data');
  await source.fill('Avery Lee\nJordan Lee');

  await page.getByRole('button', { name: 'Gallery' }).click();
  const pending = page.getByRole('region', { name: 'Your pending work is not saved' });
  await expect(pending).toBeVisible();
  await expect(pending).toBeFocused();
  await expectTouchTargets(pending, 'button', 'pending-work actions at 320');
  await pending.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByRole('heading', { name: 'Add guests' })).toBeVisible();
  await expect(source).toHaveValue('Avery Lee\nJordan Lee');
  await expect(settingsNotice).toBeVisible();

  const managerUrl = page.url();
  await page.getByRole('link', { name: 'Candidary home' }).click();
  await expect(pending).toBeVisible();
  await pending.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(managerUrl);
  await expect(source).toHaveValue('Avery Lee\nJordan Lee');

  await page.setViewportSize({ width: 390, height: 900 });
  await settingsNotice.getByRole('button', { name: 'Open settings' }).click();
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('Settings or appearance changes are also unconfirmed');
  await expectTouchTargets(pending, 'button', 'pending-work actions at 390');
  await expectContained(page, page.locator('.manager-shell--intake'), 'combined pending work at 390');
  await pending.getByRole('button', { name: 'Stay' }).click();
  await expect(settingsNotice).toBeVisible();
  await expect(source).toHaveValue('Avery Lee\nJordan Lee');

  await settingsNotice.getByRole('button', { name: 'Open settings' }).click();
  await pending.getByRole('button', { name: 'Discard draft' }).click();
  const settingsHeading = page.getByRole('heading', { name: 'Settings', exact: true });
  await expect(settingsHeading).toBeVisible();
  await expect(settingsHeading).toBeFocused();
  await expect(settingsNotice).toBeVisible();
  await expect(settingsNotice.getByRole('button', { name: 'Open settings' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Add guests' })).toHaveCount(0);
});

test('discard proceeds through a blocked SPA link and removes the browser-only draft', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}?section=rsvp`);
  await page.getByRole('button', { name: 'Add guests' }).click();
  await page.getByLabel('Guest names or spreadsheet data').fill('Avery Lee');

  await page.getByRole('link', { name: 'Candidary home' }).click();
  const pending = page.getByRole('region', { name: 'Your pending work is not saved' });
  await expect(pending).toBeVisible();
  await pending.getByRole('button', { name: 'Discard draft' }).click();

  await expect(page).toHaveURL(/\/$/u);
  await expect(page.locator('.manager-shell--intake')).toHaveCount(0);
  await expect(page.getByLabel('Guest names or spreadsheet data')).toHaveCount(0);
});

test('browser Back preserves a dirty draft on Stay and proceeds only after discard', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}?section=rsvp`);
  await page.evaluate(() => {
    const managerPath = `${location.pathname}${location.search}`;
    const current = history.state ?? {};
    history.replaceState({ ...current, idx: 0 }, '', '/');
    history.pushState({ ...current, idx: 1, key: 'rsvp-intake-back-test' }, '', managerPath);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  });
  await expect(page.getByRole('heading', { name: 'Guest list and RSVPs' })).toBeVisible();
  await page.getByRole('button', { name: 'Add guests' }).click();
  const source = page.getByLabel('Guest names or spreadsheet data');
  await source.fill('Avery Lee\nJordan Lee');
  const managerUrl = page.url();
  const pending = page.getByRole('region', { name: 'Your pending work is not saved' });

  const firstBack = page.goBack();
  await expect(pending).toBeVisible();
  await pending.getByRole('button', { name: 'Stay' }).click();
  await firstBack;
  await expect(page).toHaveURL(managerUrl);
  await expect(source).toHaveValue('Avery Lee\nJordan Lee');

  const secondBack = page.goBack();
  await expect(pending).toBeVisible();
  await pending.getByRole('button', { name: 'Discard draft' }).click();
  await secondBack;
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByLabel('Guest names or spreadsheet data')).toHaveCount(0);
});

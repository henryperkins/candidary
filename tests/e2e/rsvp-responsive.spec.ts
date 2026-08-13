import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import {
  MAX_NAMED_INVITEES_PER_HOUSEHOLD,
  MAX_PLUS_ONES_PER_HOUSEHOLD,
} from '../../shared/constants';
import type {
  GuestEventView,
  RsvpHouseholdView,
  RsvpInviteeView,
} from '../../shared/contracts';
import {
  EVENT_FIXTURE,
  RSVP_HOUSEHOLD_FIXTURE,
  stubGuestRoutes,
  stubManagerRoutes,
  stubRsvpRosterBatchRoutes,
} from './fixtures/routes';
import { LONG_RSVP_NAME, makeMedia } from './fixtures/ui-data';
import {
  measureDocument,
  measureFold,
  measureTarget,
  measureViewportEscapes,
} from './helpers/geometry';

const TOUCH_MINIMUM = 44;
const NARROW = [320, 390] as const;
const MANAGER_WIDTHS = [320, 390, 768] as const;
const DESTINATIONS = ['Intake', 'RSVP', 'Gallery', 'Guestbook', 'Share', 'Settings'] as const;

const RSVP_PRIMARY: Partial<GuestEventView> = {
  uploadsEnabled: false,
  phase: 'rsvp-primary',
  rsvpState: 'open',
  rsvpAccess: 'editable',
  rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
  rsvpDeadlineDate: '2026-09-05',
};

// The largest household the contract permits: 20 named guests and 10 plus-one
// slots, every name at the 80-character maximum with nothing to break on.
function maximumHousehold(): RsvpHouseholdView {
  const invitees: RsvpInviteeView[] = [
    ...Array.from({ length: MAX_NAMED_INVITEES_PER_HOUSEHOLD }, (_, index): RsvpInviteeView => ({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      kind: 'named',
      displayName: `${LONG_RSVP_NAME.slice(0, 77)}${String(index + 1).padStart(3, '0')}`,
      attendance: 'pending',
      order: index,
    })),
    ...Array.from({ length: MAX_PLUS_ONES_PER_HOUSEHOLD }, (_, index): RsvpInviteeView => ({
      id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      kind: 'plus_one',
      displayName: null,
      attendance: 'pending',
      order: MAX_NAMED_INVITEES_PER_HOUSEHOLD + index,
    })),
  ];
  return { ...RSVP_HOUSEHOLD_FIXTURE, label: LONG_RSVP_NAME, invitees };
}

async function expectContained(page: Page, scope: Locator, label: string) {
  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth, `${label} document width`)
    .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  expect(await measureViewportEscapes(scope), `${label} escapes`).toEqual([]);
}

async function expectTouchTargets(page: Page, selector: string, label: string) {
  const controls = page.locator(selector);
  const rendered = await controls.count();
  expect(rendered, `${label} is on screen`).toBeGreaterThan(0);
  for (let index = 0; index < rendered; index += 1) {
    const size = await measureTarget(controls.nth(index));
    expect(size.width, `${label} ${index + 1} width`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    expect(size.height, `${label} ${index + 1} height`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
  }
}

async function openLookup(page: Page, household: RsvpHouseholdView | null = RSVP_HOUSEHOLD_FIXTURE) {
  await stubGuestRoutes(page, { event: RSVP_PRIMARY, household, rsvpSession: false });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await expect(page.getByRole('heading', { name: 'Find your household invitation' })).toBeVisible();
}

test('the RSVP lookup keeps its whole first viewport at 320 by 568', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openLookup(page);

  const action = page.getByRole('button', { name: 'Find my invitation' });
  const fold = await measureFold(page, action);
  expect(fold.bottom, 'the complete action ends inside the first viewport')
    .toBeLessThanOrEqual(fold.fold);
  await expectTouchTargets(page, '.rsvp-lookup .rsvp-button', 'lookup action at 320');
  await expectContained(page, page.locator('.rsvp-flow'), 'lookup at 320');
});

test('the largest household reflows at 320 and 390 without a sideways page', async ({ page }) => {
  await openLookup(page, maximumHousehold());
  await page.getByLabel('Full name').fill('Taylor Morgan');
  await page.getByRole('button', { name: 'Find my invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();
  await expect(page.locator('.rsvp-household form').getByRole('group'))
    .toHaveCount(MAX_NAMED_INVITEES_PER_HOUSEHOLD + MAX_PLUS_ONES_PER_HOUSEHOLD);

  for (const width of NARROW) {
    await page.setViewportSize({ width, height: 844 });
    await expectTouchTargets(page, '.rsvp-attendance label', `attendance label at ${width}`);
    await expectContained(page, page.locator('.rsvp-flow'), `maximum household at ${width}`);

    // An 80-character unbroken name wraps inside its legend instead of widening it.
    const legend = page.locator('.rsvp-person legend').first();
    const legendBox = await measureTarget(legend);
    expect(legendBox.width, `legend width at ${width}`).toBeLessThanOrEqual(width);
    expect(legendBox.height, `legend wraps rather than truncates at ${width}`).toBeGreaterThan(20);
  }
});

test('long validation copy and the attending plus-one field stay contained at 320', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openLookup(page, maximumHousehold());
  await page.getByLabel('Full name').fill('Taylor Morgan');
  await page.getByRole('button', { name: 'Find my invitation' }).click();
  await page.getByRole('button', { name: 'Submit RSVP' }).click();

  await expect(page.locator('.rsvp-error').first()).toBeVisible();
  await expectContained(page, page.locator('.rsvp-flow'), 'incomplete household at 320');

  await page.getByRole('group', { name: 'Plus one 1', exact: true })
    .getByRole('radio', { name: 'Attending', exact: true }).check();
  const plusOneName = page.getByLabel('Plus one 1 name');
  await expect(plusOneName).toBeVisible();
  await plusOneName.fill(LONG_RSVP_NAME);
  await expectContained(page, page.locator('.rsvp-flow'), 'attending plus-one name at 320');
});

test('the RSVP household holds the 1280 layout at 200 per cent zoom', async ({ page }) => {
  // 1280 at 200% reflows to a 640 CSS-pixel viewport, which is the WCAG 1.4.10 case.
  await page.setViewportSize({ width: 640, height: 512 });
  await openLookup(page, maximumHousehold());
  await page.getByLabel('Full name').fill('Taylor Morgan');
  await page.getByRole('button', { name: 'Find my invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();

  await expectTouchTargets(page, '.rsvp-attendance label', 'attendance label at 640');
  await expectContained(page, page.locator('.rsvp-flow'), 'household at 200% zoom');
});

test('the before-start receipt stays contained with maximum names', async ({ page }) => {
  const household = maximumHousehold();
  await stubGuestRoutes(page, {
    // The read-only window: the hero, the start line, and the embedded receipt
    // all stack on one surface, which is more of it than the old fallback held.
    event: {
      uploadsEnabled: true,
      phase: 'before-start',
      rsvpState: 'closed',
      rsvpAccess: 'read-only',
      rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
      rsvpDeadlineDate: '2026-09-05',
    },
    household: {
      ...household,
      editable: false,
      firstRespondedAt: '2026-08-01T00:00:00Z',
      latestRespondedAt: '2026-08-01T00:00:00Z',
      latestActor: 'household',
      invitees: household.invitees.map((invitee, index) => ({
        ...invitee,
        attendance: index % 2 === 0 ? 'attending' : 'declined',
        displayName: invitee.kind === 'plus_one' && index % 2 === 0
          ? LONG_RSVP_NAME
          : invitee.displayName,
      })),
    },
  });

  for (const width of NARROW) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await expect(page.getByRole('heading', { name: 'Your RSVP' })).toBeVisible();
    await expectContained(page, page.locator('.guest-before-start'), `before-start receipt at ${width}`);
  }
});

async function openManagerRsvp(page: Page) {
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: makeMedia(1), nextCursor: null } },
    rsvp: {
      households: {
        households: [{
          id: '11111111-1111-4111-8111-111111111111',
          householdKey: 'morgan',
          label: LONG_RSVP_NAME,
          version: 4,
          archivedAt: null,
          attending: 2,
          declined: 1,
          awaitingResponse: 0,
          invitedCapacity: 3,
          firstRespondedAt: '2026-08-01T00:00:00Z',
          latestRespondedAt: '2026-08-02T00:00:00Z',
          latestActor: 'household',
          updatedAt: '2026-08-02T00:00:00Z',
        }],
        nextCursor: null,
      },
    },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}?section=rsvp`);
  await expect(page.getByRole('heading', { name: 'Guest list and RSVPs' })).toBeVisible();
}

test('six manager destinations and the RSVP panel stay contained at 320, 390, and 768', async ({ page }) => {
  await openManagerRsvp(page);

  for (const width of MANAGER_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });

    for (const name of DESTINATIONS) {
      const button = page.locator('.manager-nav nav button').filter({ hasText: name });
      await expect(button, `${name} at ${width}`).toBeVisible();
      const target = await measureTarget(button);
      expect(target.width, `${name} width at ${width}`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
      expect(target.height, `${name} height at ${width}`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    }

    // The CSV follows the list it exports rather than taking a full-width row between the filters and
    // the first household, so it is measured where it now lives.
    await expectTouchTargets(page, '.rsvp-manager__export .button', `CSV download at ${width}`);
    await expectTouchTargets(page, '.rsvp-household-list button', `household row at ${width}`);
    await expectTouchTargets(page, '.rsvp-manager__filters select', `status filter at ${width}`);
    await expectContained(page, page.locator('.manager-shell--intake'), `manager RSVP at ${width}`);
  }
});

test('the household editor and staged intake issues scroll only inside their own regions', async ({ page }) => {
  await openManagerRsvp(page);
  await page.getByRole('button', { name: new RegExp(LONG_RSVP_NAME, 'u') }).click();
  await expect(page.getByRole('heading', { name: 'The Morgan household' })).toBeVisible();

  for (const width of MANAGER_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectTouchTargets(page, '.rsvp-household-editor .button', `editor action at ${width}`);
    await expectContained(page, page.locator('.rsvp-household-editor'), `household editor at ${width}`);
  }

  await page.getByRole('button', { name: 'Close household' }).click();

  // A long, blocking issue list is the one region allowed its own scrollbar.
  await stubRsvpRosterBatchRoutes(page, EVENT_FIXTURE.id, {
    preview: ({ request, defaultResponse }) => {
      const firstHousehold = request.batch.creates[0]!;
      const firstInvitee = firstHousehold.namedInvitees[0]!;
      return {
        ...defaultResponse,
        issues: Array.from({ length: 24 }, (_, index) => ({
          clientHouseholdId: firstHousehold.clientHouseholdId,
          clientInviteeId: firstInvitee.clientInviteeId,
          field: 'namedInvitees.displayName' as const,
          code: 'invitee_name_invalid' as const,
          message: `Staged invitation ${index + 1} needs a guest name between 1 and 80 characters, and this explanation stays deliberately long.`,
          severity: 'blocking' as const,
        })),
        canCommit: false,
      };
    },
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole('button', { name: 'Add guests' }).click();
  await page.getByLabel('Guest names or spreadsheet data').fill('Taylor Morgan');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to details', exact: true }).click();
  await page.getByRole('button', { name: 'Review guests' }).click();

  const issues = page.getByRole('region', { name: 'Guest list review issues' });
  await expect(issues).toBeVisible();
  const scroll = await issues.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scroll.scrollWidth, 'staged intake issues never scroll sideways')
    .toBeLessThanOrEqual(scroll.clientWidth + 1);
  expect(scroll.scrollHeight, 'a long issue list scrolls inside its own region')
    .toBeGreaterThan(scroll.clientHeight);
  expect(await page.getByRole('button', { name: /^Add \d+ guests across/u }).count()).toBe(0);
  await expectContained(page, page.locator('.manager-shell--intake'), 'staged intake issues at 320');
});

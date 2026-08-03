import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

import type { GuestEventView, RsvpHouseholdView } from '../../shared/contracts';
import {
  GUEST_EVENT_FIXTURE,
  RSVP_HOUSEHOLD_FIXTURE,
  stubGuestRoutes,
} from './fixtures/routes';
import { measureDocument } from './helpers/geometry';

// The event route is the only clock in this suite. Every transition below is
// driven by a *relative* delay the stub hands out with a phase, so a page that
// moved itself did so on the server's arithmetic and not on the browser's — the
// clock-shift cases prove that by making the browser's deliberately wrong.

const PHONES = [
  { width: 390, height: 844 },
  { width: 320, height: 844 },
] as const;
const EVENT_URL = `/event/${GUEST_EVENT_FIXTURE.slug}`;
const BEFORE_START_HEADING = "The event hasn't started yet";
// Short enough to watch inside one test, long enough that the surface is
// demonstrably on screen before it elapses.
const BOUNDARY_MS = 1_000;
// An hour out: nothing but an explicit wake-up can be what fires.
const DISTANT_MS = 60 * 60 * 1000;
// `setTimeout` truncates anything past 2^31−1 ms to fire-immediately, so a start
// a month away would wake the page at once rather than sleep through it.
const PAST_TIMER_CEILING_MS = 30 * 24 * 60 * 60 * 1000;

const BEFORE_START: Partial<GuestEventView> = {
  uploadsEnabled: true,
  phase: 'before-start',
  rsvpState: 'closed',
  // This event never adopted RSVP, so the surface offers no household affordance
  // and issues no household request: the event route is the only traffic.
  rsvpAccess: 'unavailable',
  rsvpDeadlineAt: null,
  rsvpDeadlineDate: null,
};

const BEFORE_START_READ_ONLY: Partial<GuestEventView> = {
  ...BEFORE_START,
  rsvpAccess: 'read-only',
  rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
  rsvpDeadlineDate: '2026-09-05',
};

const PHOTOS_PRIMARY: Partial<GuestEventView> = {
  uploadsEnabled: true,
  phase: 'photos-primary',
  rsvpState: 'closed',
  rsvpAccess: 'unavailable',
  galleryVisible: false,
  lifecycleRecheckAfterMs: null,
};

const WAITING: Partial<GuestEventView> = {
  uploadsEnabled: false,
  phase: 'waiting',
  rsvpState: 'closed',
  rsvpAccess: 'unavailable',
  lifecycleRecheckAfterMs: null,
};

type EventReply = Partial<GuestEventView> | 'offline';

function onlyOnce(testInfo: TestInfo) {
  test.skip(testInfo.project.name === 'mobile', 'Viewport-pinned lifecycle evidence runs once.');
}

function respondedHousehold(): RsvpHouseholdView {
  return {
    ...RSVP_HOUSEHOLD_FIXTURE,
    editable: false,
    invitees: [
      { ...RSVP_HOUSEHOLD_FIXTURE.invitees[0]!, attendance: 'attending' },
      { ...RSVP_HOUSEHOLD_FIXTURE.invitees[1]!, attendance: 'declined' },
      { ...RSVP_HOUSEHOLD_FIXTURE.invitees[2]!, attendance: 'attending', displayName: 'Jamie Rivera' },
    ],
    firstRespondedAt: '2026-08-01T00:00:00Z',
    latestRespondedAt: '2026-08-01T00:00:00Z',
    latestActor: 'household',
  };
}

/**
 * The event route, answered from a script.
 *
 * Playwright consults handlers newest first, so this sits in front of the
 * fixture's own and hands out one reply per request. The last reply repeats: a
 * page that has reached its final phase still has to answer a reload or a
 * wake-up with the same view. The returned log is the request count as well as
 * the order, so a test can say what the page asked for and what it never did.
 */
async function stubEventSequence(page: Page, replies: readonly EventReply[]) {
  const served: string[] = [];
  await page.route(`**/api/event/${GUEST_EVENT_FIXTURE.slug}`, (route) => {
    const reply = replies[Math.min(served.length, replies.length - 1)]!;
    if (reply === 'offline') {
      served.push('offline');
      return route.fulfill({
        status: 500,
        json: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong. Try again and keep this request ID if the problem continues.',
          requestId: 'request-a',
        },
      });
    }
    const event: GuestEventView = { ...GUEST_EVENT_FIXTURE, ...reply };
    served.push(event.phase);
    return route.fulfill({ json: { data: { event, role: 'guest' }, requestId: 'request-a' } });
  });
  return served;
}

/**
 * Moves this browser's idea of "now" by whole days, in either direction.
 *
 * Only readings of the present move; an explicit instant still parses as itself,
 * so the event's own start still renders in its own zone. `performance.now()` is
 * untouched, which is the point: the hook measures elapsed time, and a device
 * whose wall clock is days out must still cross its boundary on time.
 */
async function shiftBrowserClock(page: Page, days: number) {
  await page.addInitScript((shiftMs: number) => {
    const native = Date;
    window.Date = new Proxy(native, {
      construct: (target, args) => (args.length === 0
        ? new target(native.now() + shiftMs)
        : Reflect.construct(target, args)),
      get: (target, property, receiver) => (property === 'now'
        ? () => native.now() + shiftMs
        : Reflect.get(target, property, receiver)),
    });
  }, days * 24 * 60 * 60 * 1000);
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

async function expectContained(page: Page, label: string) {
  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth, `${label} document width`)
    .toBeLessThanOrEqual(documentSize.clientWidth + 1);
}

for (const { width, height } of PHONES) {
  test.describe(`guest lifecycle at ${width} by ${height}`, () => {
    test.beforeEach(async ({ page }, testInfo) => {
      onlyOnce(testInfo);
      await page.setViewportSize({ width, height });
    });

    test('the page crosses the start on its own, with nothing touched', async ({ page }) => {
      await stubGuestRoutes(page, { event: BEFORE_START });
      const served = await stubEventSequence(page, [
        { ...BEFORE_START, lifecycleRecheckAfterMs: BOUNDARY_MS },
        PHOTOS_PRIMARY,
      ]);
      await page.goto(EVENT_URL);
      await expect(page.getByRole('heading', { name: BEFORE_START_HEADING })).toBeVisible();

      // No press, no reload, no gesture: the delay the server sent ran out.
      await expect(page.getByRole('button', { name: 'Take a photo', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: BEFORE_START_HEADING })).toHaveCount(0);
      expect(served, 'one boundary, one refetch').toEqual(['before-start', 'photos-primary']);
      await expectContained(page, 'photos after the start');
    });

    test('a failed boundary refresh leaves the surface exactly as it was', async ({ page }) => {
      await stubGuestRoutes(page, { event: BEFORE_START });
      const served = await stubEventSequence(page, [
        { ...BEFORE_START, lifecycleRecheckAfterMs: BOUNDARY_MS },
        'offline',
      ]);
      await page.goto(EVENT_URL);
      const heading = page.getByRole('heading', { name: BEFORE_START_HEADING });
      await expect(heading).toBeVisible();
      await expect
        .poll(() => served.length, { message: 'the boundary refetch was attempted' })
        .toBeGreaterThan(1);

      // A background refresh never replaces a working page with an error, and
      // never offers a recovery the guest did not ask for.
      await expect(heading).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    });

    test('a restored tab rechecks on pageshow rather than waiting out its timer', async ({ page }) => {
      await stubGuestRoutes(page, { event: BEFORE_START });
      const served = await stubEventSequence(page, [
        { ...BEFORE_START, lifecycleRecheckAfterMs: DISTANT_MS },
        PHOTOS_PRIMARY,
      ]);
      await page.goto(EVENT_URL);
      await expect(page.getByRole('heading', { name: BEFORE_START_HEADING })).toBeVisible();
      expect(served, 'an hour-away boundary has not armed anything that fires').toEqual(['before-start']);

      // A phone unlocked at the venue has usually slept through its own boundary.
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await expect(page.getByRole('button', { name: 'Take a photo', exact: true })).toBeVisible();
      expect(served).toEqual(['before-start', 'photos-primary']);
    });

    test('a boundary past the timer ceiling sleeps instead of firing at once', async ({ page }) => {
      await stubGuestRoutes(page, { event: BEFORE_START });
      const served = await stubEventSequence(page, [
        { ...BEFORE_START, lifecycleRecheckAfterMs: PAST_TIMER_CEILING_MS },
        PHOTOS_PRIMARY,
      ]);
      await page.goto(EVENT_URL);
      await expect(page.getByRole('heading', { name: BEFORE_START_HEADING })).toBeVisible();

      // Without the 24-hour slices this is the truncated-delay wake-up, and the
      // page would already be showing photos for an event a month away.
      await page.waitForTimeout(1_500);
      expect(served, 'nothing woke the page').toEqual(['before-start']);
      await expect(page.getByRole('heading', { name: BEFORE_START_HEADING })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Take a photo', exact: true })).toHaveCount(0);
    });

    for (const shiftDays of [-4, 6]) {
      const direction = shiftDays < 0 ? 'behind' : 'ahead';
      test(`the start is crossed on the server delay with a clock ${Math.abs(shiftDays)} days ${direction}`, async ({ page }) => {
        await shiftBrowserClock(page, shiftDays);
        await stubGuestRoutes(page, { event: BEFORE_START });
        const served = await stubEventSequence(page, [
          { ...BEFORE_START, lifecycleRecheckAfterMs: BOUNDARY_MS },
          PHOTOS_PRIMARY,
        ]);
        await page.goto(EVENT_URL);
        await expect(page.getByRole('heading', { name: BEFORE_START_HEADING })).toBeVisible();

        // The visible before-start heading above proves a fast device clock did
        // not switch immediately; the eventual control proves either skew
        // direction still follows the server-supplied relative delay.
        const takePhoto = page.getByRole('button', { name: 'Take a photo', exact: true });
        await expect(takePhoto).toBeVisible();
        expect(served).toEqual(['before-start', 'photos-primary']);
      });
    }

    test('the before-start surface holds one level-one heading and is axe-clean', async ({ page }) => {
      await stubGuestRoutes(page, {
        event: BEFORE_START_READ_ONLY,
        household: respondedHousehold(),
      });
      await page.goto(EVENT_URL);

      // The page owns the level-one; the embedded household content sits beneath
      // it. Two level-one headings on one page is what `embedded` exists to stop.
      await expect(page.getByRole('heading', { name: BEFORE_START_HEADING, level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Your RSVP', level: 2 })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByText('We appreciate your RSVP. Your saved household response is below.')).toBeVisible();
      await expectAccessible(page, `before-start at ${width}`);
      await expectContained(page, `before-start at ${width}`);
    });

    test('the waiting surface says only that delivery is paused and is axe-clean', async ({ page }) => {
      await stubGuestRoutes(page, { event: WAITING, household: respondedHousehold() });
      await page.goto(EVENT_URL);

      await expect(page.getByRole('heading', { name: 'Photo delivery is paused', level: 1 })).toBeVisible();
      await expect(page.getByText('The host has paused photo delivery for now. Please try again later.')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      // RSVP has left the guest experience entirely at this point.
      await expect(page.getByRole('heading', { name: 'Your RSVP' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Find my invitation' })).toHaveCount(0);
      await expectAccessible(page, `waiting at ${width}`);
      await expectContained(page, `waiting at ${width}`);
    });
  });
}

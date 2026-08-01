import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { GuestEventView, RsvpHouseholdView } from '../../shared/contracts';
import {
  EVENT_ENTRY_FIXTURE_TOKEN,
  EVENT_FIXTURE,
  RSVP_HOUSEHOLD_FIXTURE,
  stubEntryExchange,
  stubGuestRoutes,
} from './fixtures/routes';
import { measureDocument } from './helpers/geometry';

// The whole point of the feature: one string on the invitation, before the event
// and on the day. Both halves of this suite navigate exactly this URL.
const ENTRY_URL = `/join#${EVENT_ENTRY_FIXTURE_TOKEN}`;

const RSVP_PRIMARY: Partial<GuestEventView> = {
  uploadsEnabled: false,
  phase: 'rsvp-primary',
  rsvpState: 'open',
  rsvpAccess: 'editable',
  rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
  rsvpDeadlineDate: '2026-09-05',
};

// Photos opened early, so the disclosure survives beside them until the deadline.
const PHOTOS_PRIMARY: Partial<GuestEventView> = {
  uploadsEnabled: true,
  phase: 'photos-primary',
  rsvpState: 'open',
  rsvpAccess: 'editable',
  rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
  rsvpDeadlineDate: '2026-09-05',
  galleryVisible: false,
};

// The deadline has gone and the event has not begun: the window that used to be
// a `waiting` fallback talking about a date nobody could act on.
const BEFORE_START: Partial<GuestEventView> = {
  uploadsEnabled: true,
  phase: 'before-start',
  rsvpState: 'closed',
  rsvpAccess: 'read-only',
  rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
  rsvpDeadlineDate: '2026-09-05',
};

function respondedHousehold(): RsvpHouseholdView {
  return {
    ...RSVP_HOUSEHOLD_FIXTURE,
    version: 5,
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

// Scans the printed code: the real join shell reads the fragment, erases it, and
// posts it. Only the same-origin exchange is stubbed.
async function scanPrintedEntry(page: Page) {
  const submitted = await stubEntryExchange(page);
  await page.goto(ENTRY_URL);
  await expect(page).toHaveURL(new RegExp(`/event/${EVENT_FIXTURE.slug}$`, 'u'));
  expect(submitted, 'the printed credential reached the exchange exactly once')
    .toEqual([EVENT_ENTRY_FIXTURE_TOKEN]);
  // The credential is gone from the address bar and was never in a request line.
  expect(new URL(page.url()).hash).toBe('');
  return submitted;
}

async function stubSuccessfulUpload(page: Page) {
  const base = `**/api/event/${EVENT_FIXTURE.slug}`;
  await page.route(`${base}/uploads/batch`, async (route) => {
    const payload = route.request().postDataJSON() as {
      files: Array<{ idempotencyKey: string; mimeType: string }>;
    };
    const origin = new URL(page.url()).origin;
    await route.fulfill({
      status: 201,
      json: {
        data: {
          items: payload.files.map((file) => ({
            idempotencyKey: file.idempotencyKey,
            status: 'accepted',
            media: { id: `media-${file.idempotencyKey}`, mimeType: file.mimeType || 'image/jpeg' },
            uploadUrl: `${origin}/direct-upload/${file.idempotencyKey}`,
          })),
        },
        requestId: 'request-a',
      },
    });
  });
  await page.route('**/direct-upload/*', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route(`${base}/uploads/*/finalize`, (route) => route.fulfill({
    json: { data: { media: { uploadState: 'stored' } }, requestId: 'request-a' },
  }));
}

test('the printed entry opens RSVP before the event and photos on the day', async ({ page }) => {
  await stubGuestRoutes(page, {
    event: RSVP_PRIMARY,
    household: RSVP_HOUSEHOLD_FIXTURE,
    // A first scan holds no household session: the roster is matchable, not open.
    rsvpSession: false,
  });
  await scanPrintedEntry(page);

  await expect(page.getByRole('heading', { name: 'Find your household invitation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take a photo' })).toHaveCount(0);

  await page.getByLabel('Full name').fill('Taylor Morgan');
  await page.getByRole('button', { name: 'Find my invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();

  const [taylor, alex, plusOne] = RSVP_HOUSEHOLD_FIXTURE.invitees;
  await page.getByRole('group', { name: taylor!.displayName! })
    .getByRole('radio', { name: 'Attending', exact: true }).check();
  await page.getByRole('group', { name: alex!.displayName! })
    .getByRole('radio', { name: 'Not attending', exact: true }).check();
  await page.getByRole('group', { name: 'Plus one 1', exact: true })
    .getByRole('radio', { name: 'Attending', exact: true }).check();
  await page.getByLabel('Plus one 1 name').fill('Jamie Rivera');
  await page.getByRole('button', { name: 'Submit RSVP' }).click();

  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
  await expect(page.getByText('2 attending · 1 not attending')).toBeVisible();
  await expect(page.getByText('Jamie Rivera')).toBeVisible();
  expect(plusOne!.kind).toBe('plus_one');

  // A returning device restores the saved response rather than asking again.
  await page.reload();
  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
  await page.getByRole('button', { name: 'Change RSVP' }).click();
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();
  await page.getByRole('group', { name: alex!.displayName! })
    .getByRole('radio', { name: 'Attending', exact: true }).check();
  await page.getByRole('button', { name: 'Submit RSVP' }).click();
  await expect(page.getByText('3 attending · 0 not attending')).toBeVisible();

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

test('the same printed entry reaches the photo flow with RSVP behind a disclosure', async ({ page }) => {
  await stubGuestRoutes(page, {
    event: PHOTOS_PRIMARY,
    household: respondedHousehold(),
    contributions: [],
  });
  await stubSuccessfulUpload(page);
  await scanPrintedEntry(page);

  // The camera and library controls are the first thing on the page, before any
  // RSVP surface, and no household request has been made yet.
  const rsvpRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/rsvp/')) rsvpRequests.push(request.url());
  });
  const takePhoto = page.getByRole('button', { name: 'Take a photo', exact: true });
  await expect(takePhoto).toBeVisible();
  const disclosure = page.getByRole('group').filter({ hasText: 'View or change RSVP' });
  const takeBox = await takePhoto.boundingBox();
  const disclosureBox = await disclosure.boundingBox();
  expect(takeBox!.y, 'camera control precedes the RSVP disclosure')
    .toBeLessThan(disclosureBox!.y);
  expect(rsvpRequests, 'a collapsed disclosure fetches nothing').toEqual([]);

  await page.getByText('View or change RSVP').click();
  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
  await expect(page.getByText('2 attending · 1 not attending')).toBeVisible();
  expect(rsvpRequests.length, 'opening the disclosure is what loads the household')
    .toBeGreaterThan(0);

  // The approved photo journey is unchanged underneath it.
  await page.getByLabel('Your name').fill('Taylor Morgan');
  await page.locator('input[data-photo-source="camera"]').setInputFiles({
    name: 'just-taken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('captured-photo'),
  });
  await page.getByRole('button', { name: 'Send 1 photo' }).click();
  await expect(page.getByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
  // The terminal receipt hides every secondary section, RSVP included.
  await expect(page.getByText('View or change RSVP')).toHaveCount(0);
});

test('an ambiguous first name asks for a second without naming anyone', async ({ page }) => {
  await stubGuestRoutes(page, {
    event: RSVP_PRIMARY,
    lookup: { status: 'second_name_required' },
  });
  await scanPrintedEntry(page);

  await page.getByLabel('Full name').fill('Alex Lee');
  await page.getByRole('button', { name: 'Find my invitation' }).click();

  const second = page.getByLabel('Another full name');
  await expect(second).toBeVisible();
  await expect(second).toBeFocused();
  await expect(page.getByText('Enter the full name of another person on this invitation.')).toBeVisible();
  // Nothing on screen may hint at who else is on the list.
  const rendered = await page.locator('body').innerText();
  expect(rendered).not.toContain('Morgan');
  expect(rendered).not.toContain('household-a');
});

test('a name that matches nothing gets the same answer as a paused event', async ({ page }) => {
  await stubGuestRoutes(page, { event: RSVP_PRIMARY, household: null });
  await scanPrintedEntry(page);

  await page.getByLabel('Full name').fill('Nobody At All');
  await page.getByRole('button', { name: 'Find my invitation' }).click();
  await expect(page.getByText('We could not open an invitation with those details.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toHaveCount(0);
});

test('a stale version replaces the draft with the winning roster and asks for a review', async ({ page }) => {
  const winner: RsvpHouseholdView = {
    ...RSVP_HOUSEHOLD_FIXTURE,
    version: 9,
    invitees: [
      ...RSVP_HOUSEHOLD_FIXTURE.invitees,
      {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'named',
        displayName: 'Robin Morgan',
        attendance: 'pending',
        order: 3,
      },
    ],
  };
  let refused = false;
  await stubGuestRoutes(page, { event: RSVP_PRIMARY, household: RSVP_HOUSEHOLD_FIXTURE });
  // Registered after the fixture, so this refusal answers the write first. Another
  // person's edit only becomes visible once the write it beat has been refused.
  await page.route(`**/api/event/${EVENT_FIXTURE.slug}/rsvp/household`, (route) => {
    if (route.request().method() !== 'PUT') {
      return route.fulfill({
        json: {
          data: { household: refused ? winner : RSVP_HOUSEHOLD_FIXTURE },
          requestId: 'request-a',
        },
      });
    }
    refused = true;
    return route.fulfill({
      status: 409,
      json: {
        code: 'RSVP_HOUSEHOLD_CONFLICT',
        message: 'This invitation changed while you were answering.',
        requestId: 'request-a',
      },
    });
  });
  await scanPrintedEntry(page);

  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();
  for (const invitee of RSVP_HOUSEHOLD_FIXTURE.invitees) {
    const name = invitee.kind === 'named' ? invitee.displayName! : 'Plus one 1';
    await page.getByRole('group', { name }).getByRole('radio', { name: 'Not attending', exact: true }).check();
  }
  await page.getByRole('button', { name: 'Submit RSVP' }).click();

  const review = page.getByRole('heading', { name: 'Review updated household' });
  await expect(review).toBeVisible();
  await expect(review).toBeFocused();
  await expect(page.getByRole('group', { name: 'Robin Morgan' })).toBeVisible();
  await expect(page.getByText('4 to answer')).toBeVisible();
});

test('a closed deadline names the start and reads the saved response back', async ({ page }) => {
  await stubGuestRoutes(page, {
    event: BEFORE_START,
    household: { ...respondedHousehold(), editable: false },
  });
  await scanPrintedEntry(page);

  // The surface names when the event begins instead of a deadline nobody can act
  // on, and thanks a household that answered rather than reading it closed copy.
  await expect(page.getByRole('heading', { name: "The event hasn't started yet" })).toBeVisible();
  await expect(page.getByText('Maya & Theo begins September 19, 2026 at 5:00 PM.')).toBeVisible();
  await expect(page.getByText('Come back when the event begins to take or add photos.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your RSVP' })).toBeVisible();
  await expect(page.getByText('We appreciate your RSVP. Your saved household response is below.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change RSVP' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit RSVP' })).toHaveCount(0);
});

test('a device that never held a session may still look up a saved response', async ({ page }) => {
  await stubGuestRoutes(page, {
    event: BEFORE_START,
    household: { ...respondedHousehold(), editable: false },
    rsvpSession: false,
  });
  await scanPrintedEntry(page);

  // The read-only lookup is the whole point of this window, and it never names a
  // deadline: the instruction to answer would be an instruction nobody can obey.
  await expect(page.getByRole('heading', { name: 'Find your household to view a saved response.' })).toBeVisible();
  await expect(page.getByText(/Please RSVP by/u)).toHaveCount(0);
  await page.getByLabel('Full name').fill('Taylor Morgan');
  await page.getByRole('button', { name: 'Find my invitation' }).click();

  await expect(page.getByRole('heading', { name: 'Your RSVP' })).toBeVisible();
  await expect(page.getByText('2 attending · 1 not attending')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change RSVP' })).toHaveCount(0);
});

test('a scan with no credential lands on the token-free unavailable page', async ({ page }) => {
  await stubGuestRoutes(page, { event: RSVP_PRIMARY });
  await page.goto('/join');

  await expect(page).toHaveURL(/\/recover\/event-entry\?kind=unavailable$/u);
  await expect(page.getByRole('heading', { name: 'This event entry is not available.' })).toBeVisible();
  expect(page.url()).not.toContain(EVENT_ENTRY_FIXTURE_TOKEN);
});

test('a refused exchange never leaves the credential in the address bar', async ({ page }) => {
  await stubGuestRoutes(page, { event: RSVP_PRIMARY });
  await page.route('**/api/entry/exchange', (route) => route.fulfill({
    status: 404,
    json: {
      code: 'EVENT_ENTRY_UNAVAILABLE',
      message: 'This event entry is no longer available.',
      requestId: 'request-a',
    },
  }));
  await page.goto(ENTRY_URL);

  await expect(page).toHaveURL(/\/recover\/event-entry\?kind=unavailable$/u);
  expect(page.url()).not.toContain(EVENT_ENTRY_FIXTURE_TOKEN);
  expect(await page.locator('body').innerText()).not.toContain(EVENT_ENTRY_FIXTURE_TOKEN);
});

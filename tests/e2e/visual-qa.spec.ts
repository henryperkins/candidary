import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { MAX_EVENT_BYTES, MAX_EVENT_MEDIA } from '../../shared/constants';
import {
  EVENT_FIXTURE,
  RSVP_HOUSEHOLD_FIXTURE,
  stubGuestRoutes,
  stubManagerRoutes,
} from './fixtures/routes';
import { LONG_FILENAME, LONG_WELCOME, TEST_NOTE, makeMedia } from './fixtures/ui-data';
import { measureViewportEscapes } from './helpers/geometry';
import { settleRendering } from './helpers/rendering';

// This file is the tracked visual evidence. Every case pins its own viewport and asserts a committed
// baseline under `visual-qa.spec.ts-snapshots/`, so a layout that silently moves fails here rather
// than surviving in a gitignored `output/` folder nobody compares. It runs only in the `mobile`
// project — see the `testIgnore` in `playwright.config.ts` — because each state below is a phone or
// tablet one and a second desktop-emulated copy would be a picture of nobody's screen.

const previewBytes = readFileSync('public/assets/candidary-hero.png');
// A decodable file that still carries the fixture's 80-character name, so the review card is measured
// with both a real thumbnail and the worst filename a phone produces.
const KEEPER = { name: LONG_FILENAME.replace(/\.HEIC$/u, '.png'), mimeType: 'image/png', buffer: previewBytes };
const REJECT = { name: 'guest-list.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') };
const DESTINATIONS = ['Intake', 'RSVP', 'Gallery', 'Guestbook', 'Share', 'Settings'] as const;
const managerUrl = `/manage/event/${EVENT_FIXTURE.id}`;
const RSVP_PRIMARY = {
  uploadsEnabled: false,
  phase: 'rsvp-primary' as const,
  rsvpState: 'open' as const,
  rsvpAccess: 'editable' as const,
  rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
  rsvpDeadlineDate: '2026-09-05',
};
// Unpublished is the Gallery's default filter and the only state carrying every card control at once.
const MEDIA_PAGES = { first: { media: makeMedia(3, 'unpublished'), nextCursor: null } };

async function settle(page: Page) {
  // A capture must not depend on where the mouse happened to stop. Any test that clicks its way into
  // a state leaves the pointer on the control it clicked, and that control keeps its `:hover` paint —
  // the submit button on `/create` differs from its resting state by 13,077 px of chestnut-strong
  // fill. Park the pointer outside the viewport so every state below is captured at rest.
  await settleRendering(page, { parkPointer: true });
}

async function openManager(page: Page, storedMediaCount: number) {
  await stubManagerRoutes(page, {
    mediaPages: MEDIA_PAGES,
    messages: [TEST_NOTE],
    event: { storedMediaCount, ...(storedMediaCount === MAX_EVENT_MEDIA ? { storedBytes: MAX_EVENT_BYTES } : {}) },
  });
  await page.goto(managerUrl);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
}

function destination(page: Page, name: string) {
  return page.locator('.manager-nav nav button').filter({ hasText: name });
}

test('the landing first fold and workflow band hold their composition', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your event', exact: true })).toBeVisible();
  await settle(page);
  // Viewport-sized rather than full page: the claim is about what a 320 by 568 phone sees first.
  await expect(page).toHaveScreenshot('landing-first-fold-320.png');

  await page.setViewportSize({ width: 780, height: 900 });
  await page.goto('/');
  const workflow = page.locator('.workflow');
  await expect(page.locator('.workflow li')).toHaveCount(3);
  await settle(page);
  await expect(workflow).toHaveScreenshot('landing-workflow-780.png');
});

test('the create form holds its field errors and the focus they move to', async ({ page }) => {
  await page.route('**/api/events', (route) => route.fulfill({ status: 422, json: {
    code: 'VALIDATION_FAILED',
    message: 'Check the event details.',
    fieldErrors: {
      name: 'Enter an event name.',
      eventDate: 'Choose an event date.',
      welcomeMessage: 'Write a welcome message.',
    },
    requestId: 'request-a',
  } }));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/create');
  await page.getByRole('button', { name: 'Create private event' }).click();
  await expect(page.getByRole('alert')).toHaveText('Check the event details.');
  await expect(page.locator('input[name="name"]')).toBeFocused();
  await settle(page);
  await expect(page.locator('.create-form')).toHaveScreenshot('create-validation-focus-390.png');
});

test('the guest photo drop holds its longest welcome, its review, and phone landscape', async ({ page }) => {
  await stubGuestRoutes(page, { event: { welcomeMessage: LONG_WELCOME } });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await expect(page.getByRole('button', { name: 'Read full welcome' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take a photo', exact: true })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot('guest-long-welcome-320.png');

  await page.setViewportSize({ width: 844, height: 390 });
  await settle(page);
  await expect(page).toHaveScreenshot('guest-landscape-844x390.png');

  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByLabel('Your name').fill('Taylor Morgan');
  await page.locator('input[data-photo-source="library"]').setInputFiles([KEEPER, REJECT]);
  await expect(page.getByText('2 photos selected')).toBeVisible();
  await expect(page.locator('.selection-card__image img')).toHaveCount(1);
  await settle(page);
  await expect(page.locator('.photo-drop--review')).toHaveScreenshot('guest-review-320.png');
});

test('the guest secondary sections and the full-screen caption hold their longest content', async ({ page }) => {
  await stubGuestRoutes(page, { gallery: makeMedia(4), contributions: makeMedia(3) });

  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await page.locator('.event-extra summary').filter({ hasText: 'My deliveries' }).click();
  await expect(page.locator('.contributions li')).toHaveCount(3);
  await page.locator('.event-extra summary').filter({ hasText: 'Shared gallery' }).click();
  await expect(page.locator('.photo-grid figure')).toHaveCount(4);
  await settle(page);
  await expect(page.locator('.guest-secondary')).toHaveScreenshot('guest-secondary-long-content-320.png');

  await page.goto(`/event/${EVENT_FIXTURE.slug}/fullscreen`);
  await expect(page.locator('.fullscreen figure')).toHaveCount(4);
  await settle(page);
  // The first item carries the 80-character filename as its caption, which is the case that overflows.
  await expect(page.locator('.fullscreen figure').first())
    .toHaveScreenshot('fullscreen-long-caption-320.png');
});

test('the RSVP lookup, household, and receipt hold their composition', async ({ page }) => {
  await stubGuestRoutes(page, {
    event: RSVP_PRIMARY,
    household: RSVP_HOUSEHOLD_FIXTURE,
    rsvpSession: false,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await expect(page.getByRole('heading', { name: 'Find your household invitation' })).toBeVisible();
  await settle(page);
  // Viewport-sized: the claim is about the whole first screen a scan lands on.
  await expect(page).toHaveScreenshot('rsvp-lookup-390.png');

  // The household is taller than a phone screen, so the card itself is the evidence.
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByLabel('Full name').fill('Taylor Morgan');
  await page.getByRole('button', { name: 'Find my invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();
  await page.getByRole('group', { name: 'Taylor Morgan', exact: true })
    .getByRole('radio', { name: 'Attending', exact: true }).check();
  await page.getByRole('group', { name: 'Alex Morgan', exact: true })
    .getByRole('radio', { name: 'Not attending', exact: true }).check();
  await page.getByRole('group', { name: 'Plus one 1', exact: true })
    .getByRole('radio', { name: 'Attending', exact: true }).check();
  await page.getByLabel('Plus one 1 name').fill('Jamie Rivera');
  await settle(page);
  await expect(page.locator('.rsvp-household')).toHaveScreenshot('rsvp-household-320.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Submit RSVP' }).click();
  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
  await settle(page);
  await expect(page.locator('.rsvp-receipt')).toHaveScreenshot('rsvp-receipt-390.png');
});

test('the before-start surface keeps its saved response readable without an action', async ({ page }) => {
  await stubGuestRoutes(page, {
    event: {
      uploadsEnabled: true,
      phase: 'before-start',
      rsvpState: 'closed',
      rsvpAccess: 'read-only',
      rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
      rsvpDeadlineDate: '2026-09-05',
    },
    household: {
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
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await expect(page.getByRole('heading', { name: "The event hasn't started yet" })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your RSVP' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change RSVP' })).toHaveCount(0);
  await settle(page);
  // The whole surface, not the card alone: the start line and the appreciation
  // copy are the two things this state exists to say, and both sit above it.
  await expect(page.locator('.guest-before-start')).toHaveScreenshot('rsvp-before-start-390.png');
});

test('the manager guest list holds its totals, filters, and household rows', async ({ page }) => {
  await stubManagerRoutes(page, { mediaPages: MEDIA_PAGES, messages: [TEST_NOTE] });
  // The panel is taller than a phone screen and the rail is sticky, so the width
  // stays at 390 and only the capture window is opened far enough to lay it out.
  await page.setViewportSize({ width: 390, height: 1600 });
  await page.goto(`${managerUrl}?section=rsvp`);
  await expect(page.getByRole('heading', { name: 'Guest list and RSVPs' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Invited capacity' })).toBeVisible();
  await expect(page.getByRole('button', { name: /The Morgan household/u })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY), 'the panel is laid out without scrolling').toBe(0);
  await settle(page);
  await expect(page.locator('.rsvp-manager')).toHaveScreenshot('manager-rsvp-390.png');
});

test('the Manager Guestbook holds its global chrome, filters, row state, and actions at 390', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages: MEDIA_PAGES,
    messages: [{ ...TEST_NOTE, moderationStatus: 'pending' }],
  });
  await page.setViewportSize({ width: 390, height: 1400 });
  await page.goto(managerUrl);
  await destination(page, 'Guestbook').click();
  await expect(page.getByRole('heading', { name: 'Guestbook from the day' })).toBeVisible();
  const guestbook = page.getByRole('region', { name: 'Guestbook from the day' });
  await expect(guestbook.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await settle(page);
  await expect(page.locator('.manager-main')).toHaveScreenshot('manager-guestbook-390.png');
});

test('the manager rail holds its labels at 768', async ({ page }) => {
  await openManager(page, 6);
  await page.setViewportSize({ width: 768, height: 900 });
  for (const name of DESTINATIONS) await expect(destination(page, name)).toBeVisible();
  await settle(page);
  await expect(page.locator('.manager-nav')).toHaveScreenshot('manager-nav-768.png');
});

// 10,000 photos is the documented per-event cap, so this is the widest the count badge ever gets.
test('the manager rail holds its counts at the documented photo cap', async ({ page }) => {
  await openManager(page, MAX_EVENT_MEDIA);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(destination(page, 'Intake').locator('.manager-nav__count'))
    .toHaveText(String(MAX_EVENT_MEDIA));
  // Below 761 the six destinations leave the header for the foot of the viewport, so they are no
  // longer inside `.manager-nav`'s own box — screenshotting it here would picture the brand row and
  // nothing this test is named for, while `toHaveText` above went on passing off the intact DOM. The
  // subject is the destination bar, so the bar is what is captured and what is proven visible first.
  const destinations = page.locator('.manager-nav nav');
  await expect(destinations).toBeVisible();
  await settle(page);
  await expect(destinations).toHaveScreenshot('manager-nav-count-390.png');
});

test('the manager card controls and the mobile export panel hold their layout', async ({ page }) => {
  await openManager(page, 6);
  await page.setViewportSize({ width: 320, height: 844 });
  await destination(page, 'Gallery').click();
  await expect(page.getByRole('heading', { name: 'Gallery publishing' })).toBeVisible();
  const card = page.locator('.moderation-grid article').first();
  const cardContent = card.locator('.intake-card-actions').locator('..');
  // Below 761 the contact sheet's one tap target is selection and the four per-photo controls belong
  // to the chosen card, so the card is chosen before its controls are pictured. `toHaveCount` counts
  // the DOM and passed either way, which is how an unselected card could have gone on standing in for
  // a baseline named after the controls; the row is proven visible instead.
  await card.locator('.intake-select').click();
  await expect(cardContent.locator('.intake-card-actions')).toBeVisible();
  await expect(cardContent.locator('.intake-card-actions button')).toHaveCount(3);
  await settle(page);
  // The evidence is the wrapped identity and its controls. Chromium GPU processes can quantize the
  // photograph's antialiased outer corners one colour channel apart under parallel load.
  await expect(cardContent).toHaveScreenshot('manager-actions-320.png');

  // The Share section is taller than a phone screen, and the rail is sticky: scrolling any part of it
  // into view for a capture would put the rail on top of it. Phone width is what the layout is made
  // of, so the width stays at 390 and only the capture window is opened far enough that the whole
  // section is laid out at once, below the rail rather than under it.
  await page.setViewportSize({ width: 390, height: 1500 });
  await destination(page, 'Share').click();
  const share = page.locator('.manager-panel');
  await expect(page.getByRole('heading', { name: 'Share your event' })).toBeVisible();
  await expect(page.locator('.manager-export-panel--share')).toBeVisible();
  await expect(page.locator('.manager-panel img[alt="Event QR code"]')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY), 'the section is laid out without scrolling').toBe(0);
  await settle(page);
  await expect(share).toHaveScreenshot('manager-export-first-390.png');
});

// Kept from the pre-baseline visual pass: a picture proves what a state looks like, not that nothing
// left the viewport behind it. Every section is scanned on the phone the baselines were taken on.
test('every manager section stays inside the phone viewport and shows one guest entry', async ({ page }) => {
  await openManager(page, 6);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const name of DESTINATIONS) {
    await destination(page, name).click();
    await expect(destination(page, name), `${name} is the open destination`)
      .toHaveAttribute('aria-pressed', 'true');
    expect(await measureViewportEscapes(page.locator('.manager-shell--intake')), `${name} escapes the viewport`)
      .toEqual([]);
  }

  await destination(page, 'Share').click();
  await expect(page.locator('.manager-panel img[alt="Event QR code"]')).toBeVisible();
  // The utility rail's copies belong to the wide layout; on a phone the host sees exactly one.
  await expect(page.locator('.manager-utility__guest-entry')).toBeHidden();
  await expect(page.locator('.manager-utility__capacity')).toBeHidden();
});

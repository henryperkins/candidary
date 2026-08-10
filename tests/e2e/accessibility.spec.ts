import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';

import type { EventView } from '../../shared/contracts';
import { EVENT_THEME_PRESETS } from '../../shared/event-theme';
import { PHOTOGRAPHIC_COVER } from './fixtures/cover-images';
import {
  EVENT_FIXTURE,
  RSVP_HOUSEHOLD_FIXTURE,
  eventTheme,
  stubGuestRoutes,
  stubManagerRoutes,
} from './fixtures/routes';
import { UNBROKEN_TOKEN, makeMedia } from './fixtures/ui-data';
import { measureContrast, measureDocument, measureSeparation, measureTarget } from './helpers/geometry';
import { computedStyleContrast } from './helpers/theme-contrast';

// 320 is the narrowest supported phone; 768 is the tablet side of the public header's own boundary.
const HEADER_WIDTHS = [320, 768];
const RECOVERY_EVENT_ID = '11111111-2222-4333-8444-555555555555';
// The public header keeps exactly these exits: the count is asserted so neither a
// hidden one nor an added one can pass unnoticed. On `/` the row reads navigate | return | act, and
// `How it works` is the only member of it whose presence varies by width — it is a page anchor the
// hero and the footer both still offer, so below 761px it gives up its room to `Sign in`, which a
// host returning on a phone has no other route past. See `.site-nav` in `src/styles.css`.
function headerExits(width: number): { path: string; names: string[] }[] {
  const wayfinding = width > 760 ? ['How it works'] : [];
  return [
    { path: '/', names: ['Candidary home', ...wayfinding, 'Sign in', 'Create an event'] },
    { path: '/create', names: ['Candidary home', 'Back home'] },
  ];
}

const NOTE = {
  id: 'message-a',
  guestName: 'Rowan',
  body: 'To a lifetime of noticing the little things.',
  moderationStatus: 'approved' as const,
  createdAt: '2026-09-19T20:00:00Z',
};
// The six manager destinations, paired with the heading that proves the section is on screen before
// the engine reads it. An axe pass over a section that has not rendered yet proves nothing.
const MANAGER_SECTIONS = [
  { name: 'Intake', heading: 'Live intake' },
  { name: 'RSVP', heading: 'Guest list and RSVPs' },
  { name: 'Gallery', heading: 'Gallery publishing' },
  { name: 'Notes', heading: 'Notes from the day' },
  { name: 'Share', heading: 'Share your event' },
  { name: 'Settings', heading: 'Settings' },
] as const;

// axe-core 4.12.1 ships 105 rules and leaves 9 off by default, so a bare `.analyze()` is axe's
// *default* rule set, not its *full* one. One of the nine is `target-size` — WCAG 2.2 SC 2.5.8 — so
// it is switched on here explicitly. Nothing is narrowed to pay for it: no `runOnly`, no `withTags`,
// no `disableRules`, no `include`/`exclude`.
//
// Its floor is 24 x 24 CSS px with spacing, inline and essential exceptions — NOT the 44 x 44 this
// suite enforces. It is worth running, but it would not notice a 44 px control shrinking to 24: the
// 44 px floor rests entirely on the `measureTarget` assertions in this file and the responsive
// specs. A green axe run is not touch-target conformance. Which rules still do not run, and why
// that is acceptable, is recorded in `design-qa.md`.
const AXE_OPTIONS = { rules: { 'target-size': { enabled: true } } };

const THEME_ACCESSIBILITY_CASES = [
  ...EVENT_THEME_PRESETS.map(({ id, name }) => ({ name, theme: eventTheme(id) })),
  {
    name: 'custom black',
    theme: eventTheme('candidary-default', { primaryColor: '#000000', accentColor: '#000000' }),
  },
  {
    name: 'custom white',
    theme: eventTheme('candidary-default', { primaryColor: '#ffffff', accentColor: '#ffffff' }),
  },
  {
    name: 'custom mid-tone',
    theme: eventTheme('coastal-light', { primaryColor: '#767676', accentColor: '#767676' }),
  },
];

function onlyOnce(testInfo: TestInfo) {
  test.skip(testInfo.project.name === 'mobile', 'Viewport-pinned accessibility evidence runs once.');
}

// The engine runs over the whole document with axe's default rule set plus `target-size`. Narrowing
// it to make a surface pass would leave it proving nothing. Violations are reported by rule id,
// target, and axe's own explanation so a failure names the element and the measurement instead of
// dumping the rule catalogue; the array is empty exactly when `results.violations` is. Soft, so one
// run reports every surface rather than stopping at the first.
async function expectNoAxeViolations(page: Page, surface: string) {
  const results = await new AxeBuilder({ page }).options(AXE_OPTIONS).analyze();
  // A rule that never ran reports nothing, which on the wire is indistinguishable from a rule that
  // ran and found nothing. axe lists every rule it evaluated across these four buckets and omits any
  // rule that was switched off, so this is what makes the `target-size` claim in `design-qa.md`
  // checkable rather than merely written down. Remove the option above and this fails first.
  const evaluated = [results.passes, results.violations, results.incomplete, results.inapplicable]
    .flat().map(({ id }) => id);
  expect.soft(evaluated, `${surface} evaluated target-size`).toContain('target-size');
  expect.soft(
    results.violations.flatMap(({ id, impact, nodes }) => nodes.map((node) => ({
      id, impact, target: node.target, why: [...node.any, ...node.all].map(({ message }) => message),
    }))),
    `${surface} accessibility violations`,
  ).toEqual([]);
}

function animationName(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).animationName);
}

function outline(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
}

test('public actions and creation fields are keyboard reachable with named landmarks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  // The landing page now carries a footer that repeats `How it works`, `Sign in` and
  // `Create an event`, so every exit here is resolved inside the banner rather than page-wide.
  const header = page.getByRole('banner');
  await page.keyboard.press('Tab');
  await expect(header.getByRole('link', { name: 'Candidary home' })).toBeFocused();
  // `How it works` is the one header exit whose presence varies by width: visible above 760px,
  // hidden below it, where `Sign in` takes its room. This spec runs in the desktop *and* mobile
  // projects, so the tab order is asserted against what is actually on screen rather than against
  // one project's width.
  const wayfinding = header.getByRole('link', { name: 'How it works', exact: true });
  if (await wayfinding.isVisible()) {
    await page.keyboard.press('Tab');
    await expect(wayfinding).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(header.getByRole('link', { name: 'Sign in', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(header.getByRole('link', { name: 'Create an event', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Create your event', exact: true })).toBeFocused();
  await page.goto('/create');
  await expect(page.getByLabel('Event name')).toHaveAttribute('required', '');
  await expect(page.getByLabel('Event date')).toHaveAttribute('type', 'date');
  await expect(page.getByLabel('Welcome message')).toHaveAttribute('maxlength', '500');
});

test('every public header exit stays visible and mobile-sized across the width matrix', async ({ page }) => {
  for (const width of HEADER_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    for (const { path, names } of headerExits(width)) {
      await page.goto(path);
      const header = page.getByRole('banner');
      // Hiding an exit strands the visitor; adding one is unapproved navigation. Both fail here.
      await expect(header.getByRole('link'), `${path} header exits at ${width}`).toHaveCount(names.length);

      for (const name of names) {
        const link = header.getByRole('link', { name, exact: true });
        await expect(link, `${name} on ${path} at ${width}`).toBeVisible();
        const target = await measureTarget(link);
        expect(target.width, `${name} width on ${path} at ${width}`).toBeGreaterThanOrEqual(44);
        expect(target.height, `${name} height on ${path} at ${width}`).toBeGreaterThanOrEqual(44);
      }

      // Exits that touch are one mis-tap apart. Once a third exit joins the row the tightest pair is
      // no longer the outermost two — `Sign in` and `Create an event` sit together in the right-hand
      // group, far from the brand — so every neighbouring pair is measured instead of first-to-last.
      const exits = await header.getByRole('link').all();
      for (let index = 1; index < exits.length; index += 1) {
        const separation = await measureSeparation(exits[index - 1]!, exits[index]!);
        expect(separation, `${names[index - 1]} and ${names[index]} stay apart on ${path} at ${width}`)
          .toBeGreaterThanOrEqual(8);
      }

      const documentSize = await measureDocument(page);
      expect(documentSize.scrollWidth, `${path} contained at ${width}`)
        .toBeLessThanOrEqual(documentSize.clientWidth + 1);
    }
  }
});

test('cover photo focus lands on the control the host can actually see', async ({ page }) => {
  await page.goto('/create');
  const field = page.locator('.cover-field');
  const input = page.locator('.cover-field__input');
  await expect(field).toBeVisible();
  await expect(input).toHaveAttribute('type', 'file');

  const target = await measureTarget(field);
  expect(target.width, 'cover control width').toBeGreaterThanOrEqual(44);
  expect(target.height, 'cover control height').toBeGreaterThanOrEqual(44);

  await page.getByLabel('Welcome message').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('radio', { name: /Candidary Default/u })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();

  const visibleRing = await outline(field);
  expect(visibleRing.style, 'the visible cover control draws the focus ring').toBe('solid');
  expect(visibleRing.width, 'focus ring width').toBeGreaterThanOrEqual(2);

  const hiddenRing = await outline(input);
  expect(hiddenRing.style, 'no ring on the control the host cannot see').toBe('none');
  expect(hiddenRing.width).toBe(0);
});

test('guest photo sources have mobile-sized targets and name errors focus the field', async ({ page }) => {
  await page.route('**/api/event/maya-theo', (route) => route.fulfill({ json: { data: { event: {
    id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Help us remember tonight.',
    uploadsEnabled: true, galleryVisible: false, moderationRequired: true,
    cover: { revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' },
    eventTimezone: 'America/Chicago', eventStartAt: '2026-09-19T22:00:00.000Z',
    rsvpDeadlineAt: null, rsvpDeadlineDate: null, phase: 'photos-primary', rsvpState: 'disabled',
    rsvpAccess: 'unavailable', lifecycleRecheckAfterMs: null,
    theme: eventTheme('candidary-default'),
  }, role: 'guest' }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/contributions', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/messages', (route) => route.fulfill({ json: { data: { items: [] }, requestId: 'r' } }));
  await page.goto('/event/maya-theo');

  const camera = page.getByRole('button', { name: 'Take a photo', exact: true });
  const library = page.getByRole('button', { name: 'Choose recent photos', exact: true });
  for (const target of [camera, library]) {
    await expect.poll(async () => (await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect.poll(async () => (await target.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await camera.click();
  await expect(page.getByLabel('Your name')).toBeFocused();
  await expect(page.getByText('Enter your name before adding photos.')).toHaveAttribute('role', 'alert');
});

test('guest RSVP lookup and household editor are semantic, touch-sized, focus-correct, and axe-clean', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubGuestRoutes(page, {
    event: {
      uploadsEnabled: false,
      phase: 'rsvp-primary',
      rsvpState: 'open',
      rsvpAccess: 'editable',
      rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
      rsvpDeadlineDate: '2026-09-05',
    },
    lookup: { status: 'matched', household: RSVP_HOUSEHOLD_FIXTURE },
  });

  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  const name = page.getByLabel('Full name');
  await expect(name).toBeVisible();
  await expect(name).toHaveAttribute('autocomplete', 'name');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expectNoAxeViolations(page, 'guest RSVP lookup');

  await name.fill('Taylor Morgan');
  await page.getByRole('button', { name: 'Find my invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();
  await expect(page.getByRole('group')).toHaveCount(3);
  for (const fieldset of await page.getByRole('group').all()) {
    for (const label of ['Attending', 'Not attending']) {
      const radio = fieldset.getByRole('radio', { name: label, exact: true });
      await expect(radio).toHaveAccessibleName(label);
      const target = await measureTarget(radio.locator('..'));
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
  }
  await expectNoAxeViolations(page, 'guest RSVP household editor');

  await page.getByRole('button', { name: 'Submit RSVP' }).click();
  const first = page.getByRole('group', { name: 'Taylor Morgan' })
    .getByRole('radio', { name: 'Attending', exact: true });
  await expect(first).toBeFocused();
  const describedBy = await first.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText('Choose attending or not attending.');
});

test('RSVP ambiguity, conflict, receipt, and keyboard-only operation stay announced and focused', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let ambiguous = true;
  let refused = false;
  const winner = {
    ...RSVP_HOUSEHOLD_FIXTURE,
    version: 9,
    invitees: [
      ...RSVP_HOUSEHOLD_FIXTURE.invitees,
      {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'named' as const,
        displayName: 'Robin Morgan',
        attendance: 'pending' as const,
        order: 3,
      },
    ],
  };
  await stubGuestRoutes(page, {
    event: {
      uploadsEnabled: false,
      phase: 'rsvp-primary',
      rsvpState: 'open',
      rsvpAccess: 'editable',
      rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
      rsvpDeadlineDate: '2026-09-05',
    },
  });
  await page.route(`**/api/event/${EVENT_FIXTURE.slug}/rsvp/lookup`, (route) => {
    if (ambiguous) {
      ambiguous = false;
      return route.fulfill({ json: { data: { status: 'second_name_required' }, requestId: 'r' } });
    }
    return route.fulfill({
      json: { data: { status: 'matched', household: RSVP_HOUSEHOLD_FIXTURE }, requestId: 'r' },
    });
  });
  await page.route(`**/api/event/${EVENT_FIXTURE.slug}/rsvp/household`, (route) => {
    if (route.request().method() !== 'PUT') {
      return refused
        ? route.fulfill({ json: { data: { household: winner }, requestId: 'r' } })
        : route.fulfill({
            status: 401,
            json: { code: 'RSVP_SESSION_REQUIRED', message: 'Find your invitation to continue.', requestId: 'r' },
          });
    }
    refused = true;
    return route.fulfill({
      status: 409,
      json: { code: 'RSVP_HOUSEHOLD_CONFLICT', message: 'This invitation changed.', requestId: 'r' },
    });
  });

  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  // Keyboard only: reach the name field and the action without a pointer.
  const firstName = page.getByLabel('Full name');
  let tabs = 0;
  while (tabs < 8 && !await firstName.evaluate((element) => element === document.activeElement)) {
    await page.keyboard.press('Tab');
    tabs += 1;
  }
  expect(tabs, 'the lookup field is a few tabs from the top of the page').toBeLessThan(8);
  await expect(firstName).toBeFocused();
  await page.keyboard.type('Alex Lee');
  await page.keyboard.press('Enter');

  const second = page.getByLabel('Another full name');
  await expect(second, 'ambiguity moves focus to the second name').toBeFocused();
  const status = page.locator('.rsvp-status');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveText('Enter the full name of another person on this invitation.');
  await expectNoAxeViolations(page, 'guest RSVP ambiguity');

  await page.keyboard.type('Taylor Morgan');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();
  for (const invitee of RSVP_HOUSEHOLD_FIXTURE.invitees) {
    const name = invitee.kind === 'named' ? invitee.displayName! : 'Plus one 1';
    await page.getByRole('group', { name, exact: true })
      .getByRole('radio', { name: 'Not attending', exact: true }).check();
  }
  await page.getByRole('button', { name: 'Submit RSVP' }).click();

  const review = page.getByRole('heading', { name: 'Review updated household' });
  await expect(review, 'a conflict returns the respondent to the top of the winning roster').toBeFocused();
  await expectNoAxeViolations(page, 'guest RSVP conflict review');
});

test('the saved RSVP receipt is announced, contained, and axe-clean', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubGuestRoutes(page, {
    event: {
      uploadsEnabled: false,
      phase: 'rsvp-primary',
      rsvpState: 'open',
      rsvpAccess: 'editable',
      rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
      rsvpDeadlineDate: '2026-09-05',
    },
    household: {
      ...RSVP_HOUSEHOLD_FIXTURE,
      invitees: RSVP_HOUSEHOLD_FIXTURE.invitees.map((invitee, index) => ({
        ...invitee,
        attendance: index === 1 ? ('declined' as const) : ('attending' as const),
        displayName: invitee.kind === 'plus_one' ? 'Jamie Rivera' : invitee.displayName,
      })),
      firstRespondedAt: '2026-08-01T00:00:00Z',
      latestRespondedAt: '2026-08-01T00:00:00Z',
      latestActor: 'household' as const,
    },
  });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);

  const receipt = page.locator('.rsvp-flow--receipt .rsvp-receipt');
  await expect(receipt).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
  await expect(page.getByText('2 attending · 1 not attending')).toBeVisible();
  const change = page.getByRole('button', { name: 'Change RSVP' });
  const target = await measureTarget(change);
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  await expectNoAxeViolations(page, 'guest RSVP receipt');
});

test('reduced motion stops every guest spinner instead of racing it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  let releaseEvent = () => {};
  const eventGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
  let releaseBatch = () => {};
  const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
  const base = `**/api/event/${EVENT_FIXTURE.slug}`;

  await page.route(base, async (route) => {
    await eventGate;
    await route.fulfill({
      json: {
        data: { event: { ...EVENT_FIXTURE, theme: eventTheme('midnight-film') }, role: 'guest' },
        requestId: 'r',
      },
    });
  });
  await page.route(`${base}/contributions`, (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route(`${base}/messages`, (route) => route.fulfill({ json: { data: { items: [] }, requestId: 'r' } }));
  await page.route(`${base}/uploads/batch`, async (route) => {
    await batchGate;
    const payload = route.request().postDataJSON() as { files: Array<{ idempotencyKey: string }> };
    await route.fulfill({ status: 201, json: { data: { items: payload.files.map(({ idempotencyKey }) => ({
      idempotencyKey, status: 'rejected', error: { message: 'Reception dropped out. Try this photo again.' },
    })) }, requestId: 'r' } });
  });

  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  const appSpinner = page.locator('.spin');
  await expect(appSpinner).toBeVisible();
  expect(await animationName(appSpinner)).toBe('none');
  releaseEvent();

  await page.getByLabel('Your name').fill('Taylor Morgan');
  await page.locator('input[data-photo-source="library"]').setInputFiles({
    name: 'recent.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('recent-photo'),
  });
  await page.getByRole('button', { name: 'Send 1 photo' }).click();

  const cardSpinner = page.locator('.selection-card__spinner svg');
  await expect(cardSpinner).toBeVisible();
  expect(await animationName(cardSpinner)).toBe('none');

  const sendSpinner = page.locator('.send-button svg');
  await expect(sendSpinner).toBeVisible();
  expect(await animationName(sendSpinner)).toBe('none');

  releaseBatch();
  await expect(page.getByRole('button', { name: 'Retry 1 photo' })).toBeVisible();
});

test('manager navigation exposes visible labels, selected state, and mobile-sized targets', async ({ page }) => {
  const event = {
    ...EVENT_FIXTURE,
    welcomeMessage: 'Welcome.',
    galleryVisible: false,
    storedMediaCount: 0,
    storedBytes: 0,
  };
  await page.route('**/api/manage/events/event-a', (route) => route.fulfill({ json: { data: { event }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/media*', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/messages', (route) => route.fulfill({ json: { data: { messages: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/exports', (route) => route.fulfill({ json: { data: { exports: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/entry', (route) => route.fulfill({ json: { data: { eventLink: 'https://candidary.test/join#entry-id.entry-secret', disabledAt: null }, requestId: 'r' } }));
  await page.goto('/manage/event/event-a');
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();

  const intake = page.getByRole('button', { name: 'Intake', exact: true });
  await expect(intake).toHaveAttribute('aria-pressed', 'true');
  for (const name of MANAGER_SECTIONS.map(({ name: destination }) => destination)) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const label = button.locator('.manager-nav__label');
    await expect(label).toBeVisible();
    expect(await label.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(0);
    expect((await label.boundingBox())?.height ?? 0).toBeGreaterThan(0);
    // Measured from the colours the browser resolved, so a token that never reaches the label fails here.
    expect(await measureContrast(label), `${name} label contrast`).toBeGreaterThanOrEqual(4.5);
  }

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(intake).toHaveAttribute('aria-pressed', 'false');
});

test('full-page manager recovery is labelled, associated, touch-sized, contained, and axe-clean', async ({ page }) => {
  await stubManagerRoutes(page, {
    event: { id: RECOVERY_EVENT_ID },
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.route(new RegExp(`/api/manage/events/${RECOVERY_EVENT_ID}$`, 'u'), (route) => route.fulfill({
    status: 401,
    json: { code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a' },
  }));
  await page.goto(`/manage/event/${RECOVERY_EVENT_ID}`);

  const input = page.getByRole('textbox', { name: 'Management link' });
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('autocomplete', 'off');
  await expect(input).toHaveAttribute('spellcheck', 'false');
  await input.fill('/manage/event');
  await page.getByRole('button', { name: 'Open event manager' }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  const errorId = await input.getAttribute('aria-describedby');
  expect(errorId, 'the visible validation message is field-associated').toBeTruthy();
  await expect(page.locator(`#${errorId}`)).toHaveText('Enter a Candidary management link.');

  for (const target of [
    page.getByRole('link', { name: 'Sign in' }),
    page.getByRole('button', { name: 'Open event manager' }),
  ]) {
    const size = await measureTarget(target);
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth, `full-page recovery contained at ${width}`)
      .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
  await expectNoAxeViolations(page, 'full-page manager recovery');
});

test('inline manager recovery keeps forms outside alerts and remains touch-sized, contained, and axe-clean', async ({ page }) => {
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
  await expect(page.getByRole('alert').locator('form')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Management link' })).toBeVisible();
  for (const target of [
    page.getByRole('link', { name: 'Sign in' }),
    page.getByRole('button', { name: 'Open event manager' }),
  ]) {
    const size = await measureTarget(target);
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth, `inline recovery contained at ${width}`)
      .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
  await expectNoAxeViolations(page, 'inline manager recovery');
});

test('the public surfaces carry no automated accessibility violation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoAxeViolations(page, 'landing');

  await page.goto('/create');
  await expect(page.getByLabel('Event name')).toBeVisible();
  await expectNoAxeViolations(page, 'create');

  // The success state is the same route with a different document: a QR aside, both private links,
  // and the reveal control. It is where the host's only copy of the management link lives.
  await page.route('**/api/events', (route) => route.fulfill({ status: 201, json: { data: {
    event: EVENT_FIXTURE,
    eventLink: UNBROKEN_TOKEN,
    managementLink: `${UNBROKEN_TOKEN}-manage`,
    csrfToken: 'csrf-a',
  }, requestId: 'request-a' } }));
  await page.getByLabel('Event name').fill('Maya & Theo');
  await page.getByLabel('Event date').fill('2026-09-19');
  await page.getByLabel('Welcome message').fill('Come share the moments you caught.');
  await page.getByRole('button', { name: 'Create private event' }).click();
  await expect(page.getByRole('heading', { name: 'Your event is ready.' })).toBeVisible();
  await page.getByRole('button', { name: 'Show full event link' }).click();
  await expect(page.locator('.link-card--expanded code')).toHaveCount(1);
  await expectNoAxeViolations(page, 'create success');
});

test('the guest surfaces carry no automated accessibility violation', async ({ page }) => {
  await stubGuestRoutes(page, {
    gallery: makeMedia(3),
    contributions: makeMedia(2),
    messages: [NOTE],
  });

  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await expect(page.getByRole('heading', { name: EVENT_FIXTURE.welcomeMessage })).toBeVisible();
  await expectNoAxeViolations(page, 'guest hero');

  // The secondary disclosures are collapsed by default, so their content is outside the hero pass.
  for (const [summary, rendered] of [
    ['Shared gallery', '.photo-grid figure'],
    ['My deliveries', '.contributions li'],
    ['Guest notes', '.note-form textarea'],
  ] as const) {
    await page.locator('.event-extra summary').filter({ hasText: summary }).click();
    await expect(page.locator(rendered).first()).toBeVisible();
  }
  await expectNoAxeViolations(page, 'guest secondary content');

  await page.goto(`/event/${EVENT_FIXTURE.slug}/fullscreen`);
  await expect(page.locator('.fullscreen figure')).toHaveCount(3);
  await expectNoAxeViolations(page, 'fullscreen gallery');
});

for (const { name, theme } of THEME_ACCESSIBILITY_CASES) {
  test(`${name} guest theme passes Axe and computed text, action, boundary, and focus contrast`, async ({ page }, testInfo) => {
    onlyOnce(testInfo);
    await page.setViewportSize({ width: 390, height: 844 });
    await stubGuestRoutes(page, { event: { theme } });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await expect(page.getByRole('heading', { name: EVENT_FIXTURE.welcomeMessage })).toBeVisible();
    await expectNoAxeViolations(page, `${name} guest theme`);

    const nameInput = page.getByLabel('Your name');
    const helper = page.getByText('No account needed. Your name is remembered here.');
    const action = page.getByRole('button', { name: 'Take a photo', exact: true });
    expect(await measureContrast(helper), `${name} text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(await measureContrast(action), `${name} action text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(
      await computedStyleContrast(nameInput, 'borderTopColor'),
      `${name} input boundary contrast`,
    ).toBeGreaterThanOrEqual(3);

    await nameInput.focus();
    expect(
      await computedStyleContrast(nameInput, 'outlineColor', page.locator('.photo-drop')),
      `${name} focus contrast`,
    ).toBeGreaterThanOrEqual(3);
  });
}

test('theme radios have textual names, native checked state, and a full-document manager Settings Axe pass', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 390, height: 1400 });
  await page.goto('/create');
  for (const preset of EVENT_THEME_PRESETS) {
    const radio = page.getByRole('radio', { name: new RegExp(preset.name, 'u') });
    await expect(radio).toHaveAccessibleName(new RegExp(preset.name, 'u'));
    await radio.check();
    await expect(radio).toBeChecked();
  }

  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Event appearance editor' })).toBeVisible();
  await expect(page.locator('.event-appearance-canvas')).toBeVisible();
  const colorInputBorder = await page.getByLabel('Primary color picker').evaluate((element) => {
    const tokenProbe = document.createElement('span');
    tokenProbe.style.color = 'var(--border)';
    document.body.append(tokenProbe);
    const expected = getComputedStyle(tokenProbe).color;
    tokenProbe.remove();
    return {
      actual: getComputedStyle(element).borderTopColor,
      expected,
    };
  });
  expect(colorInputBorder.actual, 'Manager color input uses the global border token').toBe(colorInputBorder.expected);
  for (const toggle of await page.locator('.settings-form .toggle').all()) {
    const target = await measureTarget(toggle);
    expect(target.width, 'Settings toggle label width').toBeGreaterThanOrEqual(44);
    expect(target.height, 'Settings toggle label height').toBeGreaterThanOrEqual(44);
    const checkbox = await measureTarget(toggle.locator('input'));
    expect(checkbox.width, 'Settings checkbox width').toBeGreaterThanOrEqual(24);
    expect(checkbox.height, 'Settings checkbox height').toBeGreaterThanOrEqual(24);
  }
  for (const preset of EVENT_THEME_PRESETS) {
    const radio = page.getByRole('radio', { name: new RegExp(preset.name, 'u') });
    await expect(radio).toHaveAccessibleName(new RegExp(preset.name, 'u'));
    await radio.check();
    await expect(radio).toBeChecked();
  }
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expectNoAxeViolations(page, 'manager Settings editor and preview');
});

test('Cover Studio loading, error, edit, confirmation, and preparing states are axe-clean', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 1280, height: 900 });
  const uploadCover: EventView['cover'] = {
    ...EVENT_FIXTURE.cover,
    config: {
      version: 1,
      source: { kind: 'upload' },
      focus: { mode: 'manual', x: 0.3, y: 0.7, zoom: 1.2 },
      effect: 'soft',
    },
    revision: 9,
    hasCover: true,
  };
  await stubManagerRoutes(page, {
    event: { cover: uploadCover },
    mediaPages: { first: { media: [], nextCursor: null } },
    cover: PHOTOGRAPHIC_COVER,
    coverScenario: {
      previewFailures: { natural: 1 },
      previewDelaysMs: { natural: 2_500 },
      publicationReplies: [{ operationStatus: 'preparing', status: 202, retryAfter: '30' }],
    },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expectNoAxeViolations(page, 'Manager cover canvas');

  await page.getByRole('button', { name: 'Change cover' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a cover' })).toBeFocused();
  await expectNoAxeViolations(page, 'Cover Studio Choose');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Preparing your photo…')).toBeVisible();
  await expectNoAxeViolations(page, 'Cover Studio loading');

  const retry = page.getByRole('button', { name: 'Try preparing again' });
  await expect(retry).toBeFocused({ timeout: 5_000 });
  await expectNoAxeViolations(page, 'Cover Studio actionable error');
  await retry.click();
  await expect(page.getByRole('button', { name: 'Adjust focus' })).toBeVisible({ timeout: 5_000 });
  await expectNoAxeViolations(page, 'Cover Studio Compose');

  await page.getByRole('button', { name: 'Adjust focus' }).click();
  await page.getByRole('slider', { name: 'Horizontal focus' }).press('ArrowRight');
  await page.getByRole('button', { name: 'Cancel' }).click();
  const discard = page.getByRole('alertdialog', { name: 'Discard cover changes' });
  await expect(discard.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await expectNoAxeViolations(page, 'Cover Studio discard alertdialog');
  await discard.getByRole('button', { name: 'Keep editing' }).click();

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a style' })).toBeFocused();
  await expectNoAxeViolations(page, 'Cover Studio Style');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Save this cover' })).toBeFocused();
  await expectNoAxeViolations(page, 'Cover Studio Done');

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog', { name: 'Cover Studio' }).getByRole('status'))
    .toContainText('Preparing cover');
  await expectNoAxeViolations(page, 'Cover Studio preparing');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.cover-preparation')).toContainText('Preparing cover');
  await expectNoAxeViolations(page, 'Manager cover preparation');
});

for (const terminal of [
  { name: 'retryable', status: 'retryable-failed' as const, code: 503, retryable: true },
  { name: 'permanent', status: 'permanent-failed' as const, code: 503, retryable: false },
  { name: 'conflict', status: 'conflict' as const, code: 409, retryable: false },
]) {
  test(`Cover Studio ${terminal.name} terminal state is axe-clean`, async ({ page }, testInfo) => {
    onlyOnce(testInfo);
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubManagerRoutes(page, {
      mediaPages: { first: { media: [], nextCursor: null } },
      coverScenario: {
        publicationReplies: [{
          operationStatus: terminal.status,
          status: terminal.code,
          retryable: terminal.retryable,
          includeEvent: true,
        }],
      },
    });
    await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Change cover' }).click();
    await page.getByRole('radio', { name: 'Warm Linen' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog', { name: 'Cover Studio' })).toBeVisible();
    await expectNoAxeViolations(page, `Cover Studio ${terminal.name} terminal`);
  });
}

test('every manager section carries no automated accessibility violation', async ({ page }) => {
  await stubManagerRoutes(page, {
    // Unpublished is the Gallery's default filter and the state that renders every card control.
    mediaPages: { first: { media: makeMedia(3, 'unpublished'), nextCursor: null } },
    messages: [NOTE],
    event: { storedMediaCount: 3 },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);

  for (const { name, heading } of MANAGER_SECTIONS) {
    await page.locator('.manager-nav nav button').filter({ hasText: name }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expectNoAxeViolations(page, `manager ${name}`);
  }
});

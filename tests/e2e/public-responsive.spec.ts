import { expect, test } from '@playwright/test';

import { EVENT_FIXTURE, stubManagerRoutes } from './fixtures/routes';
import { UNBROKEN_TOKEN, makeMedia } from './fixtures/ui-data';
import {
  measureDocument,
  measureFold,
  measureGridTracks,
  measureOverflow,
  measureTarget,
} from './helpers/geometry';

// The audit's phone matrix. 430 has no fold pair because the audit only records its composition.
const FOLD_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
];
const PHONE_WIDTHS = [320, 360, 390, 430];
const MANAGEMENT_LINK = `${UNBROKEN_TOKEN}-manage`;
const SENSITIVE_LINK_MASK = '••••••••••••';
// 761 is the guest enhancement boundary; 780 and 860 sit inside the tablet band above it.
const TABLET_WIDTHS = [761, 780, 860];
// The design system holds workflow body copy readable; below this a step reads as a broken column.
const MIN_STEP_TEXT_WIDTH = 160;
// Both sides of the two breakpoints this surface introduces, so neither can be moved unnoticed.
const LANDING_BOUNDARIES = [
  { width: 699, workflowColumns: 1, heroColumns: 1 },
  { width: 700, workflowColumns: 2, heroColumns: 1 },
  { width: 899, workflowColumns: 2, heroColumns: 1 },
  { width: 900, workflowColumns: 3, heroColumns: 2 },
];
// The phone matrix plus the tablet side of the 760 px boundary, where create and success turn two-column.
const CREATE_WIDTHS = [...PHONE_WIDTHS, 768];
// The design system holds field-level error text inside the caption band.
const CAPTION_TEXT_RANGE = { min: 12, max: 14 };
const CREATE_FIELD_ERRORS = {
  code: 'VALIDATION_FAILED',
  message: 'Check the event details.',
  fieldErrors: {
    name: 'Enter an event name.',
    eventDate: 'Choose an event date.',
    welcomeMessage: 'Write a welcome message.',
  },
  requestId: 'request-a',
};
const CREATE_ERROR_FIELDS = [
  { control: 'input[name="name"]', id: 'name-error', message: 'Enter an event name.' },
  { control: 'input[name="eventDate"]', id: 'eventDate-error', message: 'Choose an event date.' },
  { control: 'textarea[name="welcomeMessage"]', id: 'welcomeMessage-error', message: 'Write a welcome message.' },
];

test('the landing headline and primary action lead the first fold on phones', async ({ page }) => {
  for (const { width, height } of FOLD_VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.goto('/');

    const headline = page.getByRole('heading', { level: 1 });
    const action = page.getByRole('link', { name: 'Create your event', exact: true });
    await expect(headline).toBeVisible();
    await expect(action).toBeVisible();

    const headlineBounds = await measureFold(page, headline);
    expect(headlineBounds.bottom, `headline within the ${width} by ${height} fold`)
      .toBeLessThanOrEqual(headlineBounds.fold);

    const actionBounds = await measureFold(page, action);
    expect(actionBounds.bottom, `primary action within the ${width} by ${height} fold`)
      .toBeLessThanOrEqual(actionBounds.fold);

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

test('the landing copy precedes the decorative hero image on phones', async ({ page }) => {
  for (const width of PHONE_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');

    const headline = await measureFold(page, page.getByRole('heading', { level: 1 }));
    const image = await measureFold(page, page.locator('.hero__image'));
    expect(image.top, `hero image follows the headline at ${width}`).toBeGreaterThan(headline.bottom);

    expect((await measureGridTracks(page.locator('.hero'))).length, `hero columns at ${width}`).toBe(1);
    expect((await measureGridTracks(page.locator('.workflow ol'))).length, `workflow columns at ${width}`)
      .toBe(1);

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

test('workflow steps keep a readable text column across the tablet band', async ({ page }) => {
  for (const width of TABLET_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.workflow li')).toHaveCount(3);

    expect((await measureGridTracks(page.locator('.workflow ol'))).length, `workflow columns at ${width}`)
      .toBe(2);

    const stepWidths = await page.locator('.workflow li p').evaluateAll(
      (elements) => elements.map((element) => element.getBoundingClientRect().width),
    );
    expect(stepWidths).toHaveLength(3);
    stepWidths.forEach((stepWidth, index) => {
      expect(stepWidth, `workflow step ${index + 1} text width at ${width}`)
        .toBeGreaterThanOrEqual(MIN_STEP_TEXT_WIDTH);
    });

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

test('create errors reach their fields and the first one across the width matrix', async ({ page }) => {
  await page.route('**/api/events', (route) => route.fulfill({ status: 422, json: CREATE_FIELD_ERRORS }));

  for (const width of CREATE_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/create');
    await page.getByRole('button', { name: 'Create private event' }).click();
    await expect(page.getByRole('alert')).toHaveText('Check the event details.');

    for (const { control, id, message } of CREATE_ERROR_FIELDS) {
      const field = page.locator(control);
      await expect(field, `${id} is invalid at ${width}`).toHaveAttribute('aria-invalid', 'true');
      await expect(field, `${id} is described at ${width}`).toHaveAttribute('aria-describedby', id);

      // The relation only helps if it resolves to something rendered and readable.
      const description = page.locator(`#${id}`);
      await expect(description, `${id} is rendered at ${width}`).toBeVisible();
      await expect(description).toHaveText(message);

      const fontSize = await description.evaluate(
        (element) => Number.parseFloat(getComputedStyle(element).fontSize),
      );
      expect(fontSize, `${id} text size at ${width}`).toBeGreaterThanOrEqual(CAPTION_TEXT_RANGE.min);
      expect(fontSize, `${id} text size at ${width}`).toBeLessThanOrEqual(CAPTION_TEXT_RANGE.max);
    }

    await expect(page.locator('input[name="name"]'), `first invalid field focused at ${width}`).toBeFocused();

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

test('native event date and start time stay inside their fields under iOS sizing', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/create');

  // iOS WebKit currently sizes a padded native picker with a percentage width as though its content
  // box owned that percentage. Reproduce that layout calculation without replacing the real fields.
  await page.addStyleTag({
    content: 'input[type="date"], input[type="time"] { box-sizing: content-box; }',
  });

  for (const label of ['Event date', 'Event start time']) {
    const field = page.getByLabel(label);
    const fieldBounds = await field.boundingBox();
    const labelBounds = await field.locator('..').boundingBox();
    if (!fieldBounds || !labelBounds) throw new Error(`${label} and its label must be laid out`);

    expect(fieldBounds.x, `${label} starts inside its label`).toBeGreaterThanOrEqual(labelBounds.x);
    expect(fieldBounds.x + fieldBounds.width, `${label} ends inside its label`)
      .toBeLessThanOrEqual(labelBounds.x + labelBounds.width + 1);
  }

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

test('event and sensitive management links remain usable across the width matrix', async ({ page }) => {
  await page.route('**/api/events', (route) => route.fulfill({ status: 201, json: { data: {
    event: EVENT_FIXTURE,
    eventLink: UNBROKEN_TOKEN,
    managementLink: MANAGEMENT_LINK,
    csrfToken: 'csrf-a',
  }, requestId: 'request-a' } }));

  for (const width of CREATE_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/create');
    await page.getByLabel('Event name').fill('Maya & Theo');
    await page.getByLabel('Event date').fill('2026-09-19');
    await page.getByLabel('Welcome message').fill('Come share the moments you caught.');
    await page.getByRole('button', { name: 'Create private event' }).click();

    const eventCard = page.getByText('Event link', { exact: true }).locator('..');
    const eventCode = eventCard.locator('code');
    await expect(eventCode).toHaveCount(1);
    await expect(eventCode).toHaveText(UNBROKEN_TOKEN);

    const managementCard = page.getByText('Management link', { exact: true }).locator('..');
    await expect(managementCard).not.toContainText(MANAGEMENT_LINK);
    expect(await managementCard.evaluate((element, secret) => !element.outerHTML.includes(secret), MANAGEMENT_LINK))
      .toBe(true);
    await expect(managementCard.locator('.link-card__mask')).toHaveText(SENSITIVE_LINK_MASK);
    await expect(managementCard.locator('.link-card__mask')).toHaveAttribute('aria-hidden', 'true');
    await expect(managementCard.locator('input')).toHaveCount(0);

    const revealManagement = page.getByRole('button', { name: 'Reveal management link' });
    const copyManagement = page.getByRole('button', { name: 'Copy management link' });
    await expect(revealManagement).toBeVisible();
    await expect(copyManagement).toBeVisible();
    for (const [name, control] of [
      ['Reveal', revealManagement],
      ['Copy', copyManagement],
    ] as const) {
      const size = await measureTarget(control);
      expect(size.width, `${name} management-link width at ${width}`).toBeGreaterThanOrEqual(48);
      expect(size.height, `${name} management-link height at ${width}`).toBeGreaterThanOrEqual(48);
    }

    const collapsed = await measureDocument(page);
    expect(collapsed.scrollWidth).toBeLessThanOrEqual(collapsed.clientWidth + 1);

    await revealManagement.click();
    const managementInput = managementCard.getByRole('textbox', { name: 'Management link' });
    await expect(managementInput).toHaveCount(1);
    await expect(managementInput).toHaveAttribute('readonly', '');
    await expect(managementInput).toHaveValue(MANAGEMENT_LINK);
    await expect(eventCard.locator('code')).toHaveCount(1);
    const [managementFont, eventFont] = await Promise.all([
      managementInput.evaluate((element) => getComputedStyle(element).fontFamily),
      eventCode.evaluate((element) => getComputedStyle(element).fontFamily),
    ]);
    expect(managementFont, `revealed management-link typography at ${width}`).toBe(eventFont);

    const revealedManagement = await measureDocument(page);
    expect(revealedManagement.scrollWidth).toBeLessThanOrEqual(revealedManagement.clientWidth + 1);

    const revealEvent = page.getByRole('button', { name: 'Show full event link' });
    await expect(revealEvent).toBeVisible();
    const revealEventSize = await measureTarget(revealEvent);
    expect(revealEventSize.width, `event reveal target width at ${width}`).toBeGreaterThanOrEqual(44);
    expect(revealEventSize.height, `event reveal target height at ${width}`).toBeGreaterThanOrEqual(44);
    await revealEvent.click();

    // Read in full, not clipped, and reachable by keyboard so it can be selected by hand.
    const codeSize = await measureOverflow(eventCode);
    expect(codeSize.scrollWidth, `revealed link wraps at ${width}`).toBeLessThanOrEqual(codeSize.clientWidth + 1);
    await eventCode.focus();
    await expect(eventCode).toBeFocused();

    const expanded = await measureDocument(page);
    expect(expanded.scrollWidth).toBeLessThanOrEqual(expanded.clientWidth + 1);
  }
});

// A 1280 px laptop at the 200% zoom WCAG expects leaves a 640 by 450 layout viewport: narrower than the
// 700 px workflow boundary and shorter than any phone, which is where a fold claim is most easily lost.
test('the public surfaces hold the 1280-at-200%-zoom layout at 640 by 450', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 450 });

  await page.goto('/');
  const headline = page.getByRole('heading', { level: 1 });
  const action = page.getByRole('link', { name: 'Create your event', exact: true });
  await expect(headline).toBeVisible();
  const headlineBounds = await measureFold(page, headline);
  expect(headlineBounds.bottom, 'headline within the zoomed fold').toBeLessThanOrEqual(headlineBounds.fold);
  const actionBounds = await measureFold(page, action);
  expect(actionBounds.visible, 'a full primary target is reachable without scrolling')
    .toBeGreaterThanOrEqual(44);
  // Below the 700 px boundary the workflow is one column, so the zoomed layout is the phone's.
  expect((await measureGridTracks(page.locator('.workflow ol'))).length, 'workflow columns at 640').toBe(1);
  expect((await measureGridTracks(page.locator('.hero'))).length, 'hero columns at 640').toBe(1);
  const landingSize = await measureDocument(page);
  expect(landingSize.scrollWidth).toBeLessThanOrEqual(landingSize.clientWidth + 1);

  await page.goto('/create');
  const submit = page.getByRole('button', { name: 'Create private event' });
  await expect(page.getByLabel('Event name')).toBeVisible();
  await expect(submit).toBeVisible();
  const submitSize = await measureTarget(submit);
  expect(submitSize.height, 'create submit height at 640 by 450').toBeGreaterThanOrEqual(44);
  const createSize = await measureDocument(page);
  expect(createSize.scrollWidth).toBeLessThanOrEqual(createSize.clientWidth + 1);
});

test('the landing workflow and hero turn over exactly at their breakpoints', async ({ page }) => {
  for (const { width, workflowColumns, heroColumns } of LANDING_BOUNDARIES) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.workflow li')).toHaveCount(3);

    const workflowTracks = await measureGridTracks(page.locator('.workflow ol'));
    expect(workflowTracks.length, `workflow columns at ${width}`).toBe(workflowColumns);

    const heroTracks = await measureGridTracks(page.locator('.hero'));
    expect(heroTracks.length, `hero columns at ${width}`).toBe(heroColumns);

    const copy = await page.locator('.hero__copy').boundingBox();
    const image = await page.locator('.hero__image').boundingBox();
    if (!copy || !image) throw new Error(`the hero copy and image must both be laid out at ${width}`);

    if (heroColumns === 1) {
      expect(image.y, `hero image stacks under the copy at ${width}`)
        .toBeGreaterThanOrEqual(copy.y + copy.height);
    } else {
      expect(image.x, `hero image sits beside the copy at ${width}`)
        .toBeGreaterThanOrEqual(copy.x + copy.width);
      expect(image.y, `hero image shares the copy row at ${width}`).toBeLessThan(copy.y + copy.height);
    }

    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

test('the RSVP configuration fields hold their layout on the narrowest phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/create');

  const timeZone = page.getByLabel('Event time zone');
  // Defaulted from the browser rather than left for the host to guess.
  await expect(timeZone).not.toHaveValue('');

  // The start time is prefilled to midnight rather than left blank, so it is a
  // choice the host can accept rather than a hurdle or an invisible assumption.
  await expect(page.getByLabel('Event start time')).toHaveValue('00:00');

  for (const field of [
    timeZone,
    page.getByLabel('Event date'),
    page.getByLabel('Event start time'),
    page.getByLabel('RSVP deadline'),
  ]) {
    await expect(field).toBeVisible();
    const size = await measureTarget(field);
    expect(size.height, 'field height is tappable').toBeGreaterThanOrEqual(44);
    // Neither native date control may push the column wider than the phone.
    expect(size.width).toBeLessThanOrEqual(320);
  }

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

test('a refused deadline takes focus and reads as a description at 320', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/events', (route) => route.fulfill({
    status: 422,
    json: {
      code: 'VALIDATION_FAILED',
      message: 'Check the highlighted event details.',
      // The deadline is now measured against the resolved start instant, so a
      // same-day deadline is refused too — and the refusal says so.
      fieldErrors: { rsvpDeadlineDate: 'The RSVP deadline must be before the event starts.' },
      requestId: 'request-a',
    },
  }));
  await page.goto('/create');
  await page.getByLabel('Event name').fill('Maya & Theo');
  await page.getByLabel('Event date').fill('2026-09-19');
  await page.getByLabel('Event start time').fill('17:00');
  await page.getByLabel('RSVP deadline').fill('2026-09-19');
  await page.getByLabel('Welcome message').fill('Come share the moments you caught.');
  await page.getByRole('button', { name: 'Create private event' }).click();

  const deadline = page.getByLabel('RSVP deadline');
  await expect(deadline).toBeFocused();
  await expect(deadline).toHaveAttribute('aria-invalid', 'true');
  // The label still names the field; the refusal arrives only as its description.
  await expect(deadline).toHaveAccessibleName('RSVP deadline');
  await expect(deadline)
    .toHaveAccessibleDescription('The RSVP deadline must be before the event starts.');

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

test('a long public album keeps its cover, sections, captions, failed preview, and paper inside phones', async ({ page }) => {
  const token = 'album-share-id.album-share-secret';
  const title = `Album${'MayaTheo'.repeat(14)}`.slice(0, 120);
  const description = `Story${'kepttogether'.repeat(90)}`.slice(0, 1_000);
  const heading = `Dinner${'anddancing'.repeat(8)}`.slice(0, 80);
  const caption = `Photograph${'fromtheevening'.repeat(18)}`;
  const rows = makeMedia(18, 'published').map((item, index) => ({
    ...item,
    originalFilename: `private-${index + 1}.jpg`,
    caption: index === 1 ? caption : `Album photograph ${index + 1}`,
  }));
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    album: {
      pickedMediaIds: rows.map(({ id }) => id),
      title,
      description,
      coverMediaId: rows[0]!.id,
      entries: [
        { kind: 'photo', mediaId: rows[0]!.id },
        { kind: 'section', id: 'section-long', heading },
        ...rows.slice(1).map(({ id }) => ({ kind: 'photo' as const, mediaId: id })),
      ],
      publicPreviewFailures: [rows[2]!.id],
      shareActive: true,
      shareToken: token,
    },
  });

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    // Moving only from `/album` to `/album#token` is a same-document navigation;
    // begin a fresh page mount so each phone width proves the fragment exchange.
    await page.goto('/');
    await page.goto(`/album#${token}`);
    await expect(page).toHaveURL(/\/album$/u);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole('img', { name: `Cover for ${title}` })).toBeVisible();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByText(caption)).toBeVisible();
    await expect(page.getByText('Preview unavailable')).toHaveCount(1);
    await expect(page.locator('.public-album__block')).toHaveCount(2);
    await expect(page.locator('.public-album__photo')).toHaveCount(rows.length);

    for (const element of [
      page.locator('.public-album__copy h1'),
      page.locator('.public-album__copy p'),
      page.locator('.public-album__section'),
      page.locator('.public-album__photo figcaption').filter({ hasText: caption }),
    ]) {
      const size = await measureOverflow(element);
      expect(size.scrollWidth, `public album text wraps at ${width}`)
        .toBeLessThanOrEqual(size.clientWidth + 1);
    }
    const controls = page.locator('.public-album-shell a, .public-album-shell button');
    for (let index = 0; index < await controls.count(); index += 1) {
      const target = await measureTarget(controls.nth(index));
      expect(target.width, `public album control ${index + 1} width at ${width}`).toBeGreaterThanOrEqual(44);
      expect(target.height, `public album control ${index + 1} height at ${width}`).toBeGreaterThanOrEqual(44);
    }
    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth, `public album document at ${width}`)
      .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
});

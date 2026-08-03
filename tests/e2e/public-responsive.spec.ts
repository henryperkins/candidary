import { expect, test } from '@playwright/test';

import { EVENT_FIXTURE } from './fixtures/routes';
import { UNBROKEN_TOKEN } from './fixtures/ui-data';
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

test('a private link can be revealed and read across the width matrix', async ({ page }) => {
  await page.route('**/api/events', (route) => route.fulfill({ status: 201, json: { data: {
    event: EVENT_FIXTURE,
    eventLink: UNBROKEN_TOKEN,
    managementLink: `${UNBROKEN_TOKEN}-manage`,
    csrfToken: 'csrf-a',
  }, requestId: 'request-a' } }));

  for (const width of CREATE_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/create');
    await page.getByLabel('Event name').fill('Maya & Theo');
    await page.getByLabel('Event date').fill('2026-09-19');
    await page.getByLabel('Welcome message').fill('Come share the moments you caught.');
    await page.getByRole('button', { name: 'Create private event' }).click();

    const reveal = page.getByRole('button', { name: 'Show full event link' });
    await expect(reveal).toBeVisible();
    const revealSize = await measureTarget(reveal);
    expect(revealSize.width, `reveal target width at ${width}`).toBeGreaterThanOrEqual(44);
    expect(revealSize.height, `reveal target height at ${width}`).toBeGreaterThanOrEqual(44);

    const collapsed = await measureDocument(page);
    expect(collapsed.scrollWidth).toBeLessThanOrEqual(collapsed.clientWidth + 1);

    await reveal.click();
    const code = page.locator('.link-card--expanded code');
    await expect(code).toHaveCount(1);
    await expect(code).toHaveText(UNBROKEN_TOKEN);

    // Read in full, not clipped, and reachable by keyboard so it can be selected by hand.
    const codeSize = await measureOverflow(code);
    expect(codeSize.scrollWidth, `revealed link wraps at ${width}`).toBeLessThanOrEqual(codeSize.clientWidth + 1);
    await code.focus();
    await expect(code).toBeFocused();

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

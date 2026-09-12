import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { LANDING_DEMO } from '../../shared/site-content';
import { settleRendering } from './helpers/rendering';

test('the landing example switches by keyboard and touch without sending guest data', async ({ page }, testInfo) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      mutations.push(`${request.method()} ${request.url()}`);
    }
  });
  await page.goto('/');
  const demo = page.locator('.journey-demo');
  const controls = demo.getByRole('group', { name: LANDING_DEMO.controlsLabel });
  const qr = demo.locator('.journey-demo__qr');
  await expect(controls.getByRole('button', { name: 'Before', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const originalQr = await qr.getAttribute('src');
  await expect(demo.locator('form, input, select, textarea, a')).toHaveCount(0);

  const during = controls.getByRole('button', { name: 'During', exact: true });
  await during.focus();
  await page.keyboard.press('Enter');
  await expect(demo).toHaveAttribute('data-moment', 'during');
  await expect(during).toBeFocused();
  await expect(demo.getByRole('heading', { name: LANDING_DEMO.during.heading })).toBeVisible();
  await expect(qr).toHaveAttribute('src', originalQr!);

  await page.keyboard.press('Tab');
  const after = controls.getByRole('button', { name: 'After', exact: true });
  await expect(after).toBeFocused();
  await page.keyboard.press('Space');
  await expect(demo).toHaveAttribute('data-moment', 'after');
  await expect(demo.getByText(LANDING_DEMO.after.role, { exact: true })).toBeVisible();
  await expect(demo.locator('.journey-demo__host-boundary')).toHaveCSS('opacity', '1');
  await expect(demo.locator('.journey-demo__guest-connection')).toHaveCSS('opacity', '0');

  // Change again before the paper transition finishes: application state must never await animation.
  for (const label of ['Before', 'After', 'During', 'Before']) {
    const button = controls.getByRole('button', { name: label, exact: true });
    if (testInfo.project.name === 'mobile') await button.tap();
    else await button.click();
  }
  await expect(demo).toHaveAttribute('data-moment', 'before');
  await expect(demo.locator('.journey-demo__sheet[aria-hidden="false"]')).toHaveCount(1);
  await expect(demo.getByRole('heading', { name: LANDING_DEMO.after.heading })).toHaveCount(0);
  await expect(page.locator('.workflow > ol > li')).toHaveCount(3);
  expect(mutations).toEqual([]);
});

test('the landing example holds every stage across responsive and reduced-motion layouts', async ({ page }, testInfo) => {
  const widths = testInfo.project.name === 'mobile' ? [320, 390] : [780, 1440];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of widths) {
    await page.setViewportSize({ width, height: width >= 780 ? 1000 : 844 });
    await page.goto('/');
    const demo = page.locator('.journey-demo');
    await demo.scrollIntoViewIfNeeded();
    await settleRendering(page);
    const table = demo.locator('.journey-demo__table');
    const originalHeight = await table.evaluate((element) => element.getBoundingClientRect().height);

    for (const stage of LANDING_DEMO.stages) {
      await demo.getByRole('button', { name: stage.label, exact: true }).click();
      await expect(demo).toHaveAttribute('data-moment', stage.id);
      const sheet = demo.locator('.journey-demo__sheet[aria-hidden="false"]');
      await expect(sheet).toHaveCSS('opacity', '1');
      await expect(sheet).toHaveCSS('transition-duration', '0s');
      await expect(demo.locator('.journey-demo__selection')).toHaveCSS('transition-duration', '0s');
      const dimensions = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth, `${stage.id} document overflow at ${width}`).toBeLessThanOrEqual(dimensions.width + 1);
      expect(await table.evaluate((element) => element.getBoundingClientRect().height), `stable ${stage.id} scene at ${width}`)
        .toBeCloseTo(originalHeight, 1);
      for (const button of await demo.getByRole('button').all()) {
        const bounds = await button.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
      }
      const accessibility = await new AxeBuilder({ page }).include('.journey-demo').analyze();
      expect(accessibility.violations, `${stage.id} accessibility at ${width}`).toEqual([]);
      if (width < 760) {
        await demo.locator('.journey-demo__scenes').scrollIntoViewIfNeeded();
        const header = await page.locator('.page-header').boundingBox();
        const toolbar = await demo.locator('.journey-demo__toolbar').boundingBox();
        expect(toolbar!.y, `${stage.id} controls clear the header at ${width}`)
          .toBeGreaterThanOrEqual(header!.y + header!.height - 1);
        expect(toolbar!.y + toolbar!.height, `${stage.id} controls stay in reach at ${width}`)
          .toBeLessThanOrEqual(844);
      }
      // One bounded batch gives the reviewer all states at each shipped device class.
      await demo.screenshot({
        path: testInfo.outputPath(`journey-${stage.id}-${width}.png`),
        animations: 'disabled',
        // Isolated-component evidence excludes unrelated sticky page chrome.
        style: '.page-header { visibility: hidden !important; } .journey-demo__toolbar { position: relative !important; top: 0 !important; }',
      });
    }
  }
});

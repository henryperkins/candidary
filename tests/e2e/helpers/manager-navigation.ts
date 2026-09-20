import { expect, type Page } from '@playwright/test';

export async function openManagerNavigation(page: Page) {
  const toggle = page.locator('.manager-nav__toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') {
    await toggle.click();
  }
  await expect(page.locator('.manager-nav nav')).toBeVisible();
}

export async function chooseManagerSection(page: Page, name: string) {
  await openManagerNavigation(page);
  await page.locator('.manager-nav nav button').filter({ hasText: name }).click();
}

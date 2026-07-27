import type { Locator, Page } from '@playwright/test';

export async function measureDocument(page: Page) {
  return page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
}

export async function measureTarget(locator: Locator) {
  const box = await locator.boundingBox();
  return { width: box?.width ?? 0, height: box?.height ?? 0 };
}

export async function measureOverflow(locator: Locator) {
  return locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
}

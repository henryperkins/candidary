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

export async function measureFold(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const fold = await page.evaluate(() => window.innerHeight);
  const top = box?.y ?? 0;
  const bottom = top + (box?.height ?? 0);
  return { fold, top, bottom, visible: Math.min(bottom, fold) - Math.max(top, 0) };
}

// The free space between two boxes: the horizontal gap when they share a row, otherwise the vertical
// gap left by wrapping. A collision reads as 0 or less either way.
export async function measureSeparation(first: Locator, second: Locator) {
  const [leading, trailing] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  if (!leading || !trailing) return 0;
  const sharesRow = leading.y < trailing.y + trailing.height && trailing.y < leading.y + leading.height;
  return sharesRow
    ? trailing.x - (leading.x + leading.width)
    : trailing.y - (leading.y + leading.height);
}

// Resolved grid column widths. A rendered grid reports every track as a used pixel length, so anything
// else — `none`, or an unresolved `minmax(0, 1fr)` from a `display: none` element, which would
// otherwise read as three tracks — returns an empty list rather than a misleading count.
export async function measureGridTracks(locator: Locator) {
  return locator.evaluate((element) => {
    const tracks = getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u);
    return tracks.every((track) => /^-?\d*\.?\d+px$/u.test(track))
      ? tracks.map((track) => Number.parseFloat(track))
      : [];
  });
}

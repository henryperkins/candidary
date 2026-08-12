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

// Descendants whose painted box leaves the viewport sideways, named so a failure says which ones.
// Rects ignore clipping, so this still reports content an `overflow: hidden` ancestor has swallowed.
//
// Content inside a declared horizontal scroller is exempt, and only that. A snap row of cover presets
// or of RSVP total chips is *meant* to continue past the right edge, and its own scroll is how a host
// reaches the rest of it. The bug this function exists for is content that leaves the viewport with no
// way back, so `hidden` still fails, which is the case the original note was written about. The
// scroller's own box is measured as before, and `measureDocument` still fails the moment any of it
// pushes the page itself sideways.
//
// Computed `overflow-x` alone cannot carry that exemption. CSS resolves a `visible` axis to `auto` as
// soon as the other axis is not `visible`, so every vertical scroll pane — `.cover-studio__controls`
// sets only `overflow-y: auto` — reports `overflow-x: auto` and would exempt everything inside it.
// That is not theoretical: it hid a cover upload row 168px wider than a 390px phone, with `Choose
// photo` stranded off the right edge where no thumb reaches. Nor does `scrollWidth > clientWidth`
// separate the two, because the accidental overflow makes the pane scrollable in exactly the way the
// deliberate one is. The discriminator has to be something an author only writes on purpose, so a
// horizontal scroller opts in by containing its own overscroll — which it wants regardless, to stop a
// sideways swipe chaining to the page behind it.
export async function measureViewportEscapes(locator: Locator) {
  return locator.evaluate((container) => {
    const viewportWidth = document.documentElement.clientWidth;
    const insideScroller = (element: HTMLElement) => {
      for (let node = element.parentElement; node && node !== container; node = node.parentElement) {
        const { overflowX, overscrollBehaviorX } = getComputedStyle(node);
        if ((overflowX === 'auto' || overflowX === 'scroll') && overscrollBehaviorX === 'contain') return true;
      }
      return false;
    };
    return Array.from(container.querySelectorAll<HTMLElement>('*')).flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0
        && (rect.left < -1 || rect.right > viewportWidth + 1)
        && !insideScroller(element)
        ? [{ selector: `${element.tagName.toLowerCase()}.${element.getAttribute('class') ?? ''}`, left: rect.left, right: rect.right }]
        : [];
    });
  });
}

// The WCAG 2.1 contrast ratio between an element's own computed text color and the nearest ancestor
// background that actually paints. Both sides are read back from the browser, so a token that is
// overridden, inherited, or never applied is measured as what the host really sees rather than assumed.
export async function measureContrast(locator: Locator) {
  return locator.evaluate((element) => {
    const channel = (value: number) => {
      const ratio = value / 255;
      return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
    };
    const parse = (color: string) => {
      const [red = 0, green = 0, blue = 0, alpha = 1] = (color.match(/[\d.]+/gu) ?? []).map(Number);
      return { red, green, blue, alpha };
    };
    const luminance = (color: { red: number; green: number; blue: number }) =>
      0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue);

    // A transparent background paints nothing, so the ratio belongs to whatever is actually behind it.
    let painted = { red: 255, green: 255, blue: 255, alpha: 1 };
    for (let node: Element | null = element; node; node = node.parentElement) {
      const candidate = parse(getComputedStyle(node).backgroundColor);
      if (candidate.alpha > 0) { painted = candidate; break; }
    }
    const text = luminance(parse(getComputedStyle(element).color));
    const backdrop = luminance(painted);
    return (Math.max(text, backdrop) + 0.05) / (Math.min(text, backdrop) + 0.05);
  });
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

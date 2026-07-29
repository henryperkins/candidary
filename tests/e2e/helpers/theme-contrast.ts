import type { Locator, Page } from '@playwright/test';

interface PixelBuffer {
  width: number;
  height: number;
  data: number[];
}

function linear(channel: number) {
  const ratio = channel / 255;
  return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function luminance(red: number, green: number, blue: number) {
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function whiteContrast(red: number, green: number, blue: number) {
  return 1.05 / (luminance(red, green, blue) + 0.05);
}

async function screenshotPixels(page: Page, locator: Locator): Promise<PixelBuffer> {
  const screenshot = await locator.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D context unavailable.');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) };
  }, [...screenshot]);
}

export async function visiblePixelMask(locator: Locator, width: number, height: number) {
  return locator.evaluate((root, size) => {
    const rootBox = root.getBoundingClientRect();
    const clips: Array<{
      left: number;
      top: number;
      right: number;
      bottom: number;
      topLeft: [number, number];
      topRight: [number, number];
      bottomRight: [number, number];
      bottomLeft: [number, number];
    }> = [];
    const radius = (value: string, insetX: number, insetY: number): [number, number] => {
      const [horizontal = 0, vertical = horizontal] = (value.match(/[\d.]+/gu) ?? []).map(Number);
      return [Math.max(0, horizontal - insetX), Math.max(0, vertical - insetY)];
    };
    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (!['hidden', 'clip'].includes(style.overflowX)
        && !['hidden', 'clip'].includes(style.overflowY)) continue;
      const box = ancestor.getBoundingClientRect();
      const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
      const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
      const borderRight = Number.parseFloat(style.borderRightWidth) || 0;
      const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
      clips.push({
        left: box.left + borderLeft - rootBox.left,
        top: box.top + borderTop - rootBox.top,
        right: box.right - borderRight - rootBox.left,
        bottom: box.bottom - borderBottom - rootBox.top,
        topLeft: radius(style.borderTopLeftRadius, borderLeft, borderTop),
        topRight: radius(style.borderTopRightRadius, borderRight, borderTop),
        bottomRight: radius(style.borderBottomRightRadius, borderRight, borderBottom),
        bottomLeft: radius(style.borderBottomLeftRadius, borderLeft, borderBottom),
      });
    }
    const insideClip = (x: number, y: number, clip: (typeof clips)[number]) => {
      if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) return false;
      const insideCorner = (
        centerX: number,
        centerY: number,
        radiusX: number,
        radiusY: number,
      ) => radiusX === 0 || radiusY === 0
        || ((x - centerX) / radiusX) ** 2 + ((y - centerY) / radiusY) ** 2 < 1 - 1e-7;
      const [topLeftX, topLeftY] = clip.topLeft;
      if (x < clip.left + topLeftX && y < clip.top + topLeftY
        && !insideCorner(clip.left + topLeftX, clip.top + topLeftY, topLeftX, topLeftY)) return false;
      const [topRightX, topRightY] = clip.topRight;
      if (x >= clip.right - topRightX && y < clip.top + topRightY
        && !insideCorner(clip.right - topRightX, clip.top + topRightY, topRightX, topRightY)) return false;
      const [bottomRightX, bottomRightY] = clip.bottomRight;
      if (x >= clip.right - bottomRightX && y >= clip.bottom - bottomRightY
        && !insideCorner(
          clip.right - bottomRightX,
          clip.bottom - bottomRightY,
          bottomRightX,
          bottomRightY,
        )) return false;
      const [bottomLeftX, bottomLeftY] = clip.bottomLeft;
      return !(x < clip.left + bottomLeftX && y >= clip.bottom - bottomLeftY
        && !insideCorner(
          clip.left + bottomLeftX,
          clip.bottom - bottomLeftY,
          bottomLeftX,
          bottomLeftY,
        ));
    };
    const mask: number[] = [];
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const left = (x * rootBox.width) / size.width;
        const top = (y * rootBox.height) / size.height;
        const right = ((x + 1) * rootBox.width) / size.width;
        const bottom = ((y + 1) * rootBox.height) / size.height;
        mask.push(clips.every((clip) =>
          insideClip(left, top, clip)
          && insideClip(right, top, clip)
          && insideClip(right, bottom, clip)
          && insideClip(left, bottom, clip)) ? 1 : 0);
      }
    }
    return mask;
  }, { width, height });
}

export async function makeTextTransparent(locator: Locator) {
  await locator.evaluate((root) => {
    for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      const target = element as HTMLElement;
      target.style.setProperty('color', 'transparent', 'important');
      target.style.setProperty('text-shadow', 'none', 'important');
      target.style.setProperty('caret-color', 'transparent', 'important');
    }
  });
}

export async function minimumWhiteContrast(
  page: Page,
  locator: Locator,
  options: { visiblePixelsOnly?: boolean } = {},
) {
  const pixels = await screenshotPixels(page, locator);
  const mask = options.visiblePixelsOnly
    ? await visiblePixelMask(locator, pixels.width, pixels.height)
    : null;
  const maskAt = (x: number, y: number) => mask?.[y * pixels.width + x] === 1;
  const maskEvidence = mask ? {
    topCenter: maskAt(Math.floor(pixels.width / 2), 0),
    rightCenter: maskAt(pixels.width - 1, Math.floor(pixels.height / 2)),
    bottomCenter: maskAt(Math.floor(pixels.width / 2), pixels.height - 1),
    leftCenter: maskAt(0, Math.floor(pixels.height / 2)),
    topLeft: maskAt(0, 0),
    topRight: maskAt(pixels.width - 1, 0),
  } : null;
  let minimum = Number.POSITIVE_INFINITY;
  let sampledPixels = 0;
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    if (mask && mask[offset / 4] !== 1) continue;
    sampledPixels += 1;
    minimum = Math.min(
      minimum,
      whiteContrast(
        pixels.data[offset] ?? 0,
        pixels.data[offset + 1] ?? 0,
        pixels.data[offset + 2] ?? 0,
      ),
    );
  }
  return {
    minimum,
    width: pixels.width,
    height: pixels.height,
    sampledPixels,
    totalPixels: pixels.width * pixels.height,
    maskEvidence,
  };
}

export async function minimumWhiteContrastUnderText(
  page: Page,
  hero: Locator,
  copy: Locator,
) {
  const rectangles = await copy.evaluate((root) => {
    const hero = root.closest<HTMLElement>('.photo-drop__hero');
    if (!hero) throw new Error('Cover copy must be inside a guest hero.');
    const heroBox = hero.getBoundingClientRect();
    return Array.from(root.querySelectorAll<HTMLElement>('p, h1, button, span'))
      .filter((element) => element.textContent?.trim() && element.getClientRects().length > 0)
      .flatMap((element) => Array.from(element.getClientRects()).map((rect) => ({
        left: Math.max(0, Math.floor(rect.left - heroBox.left)),
        top: Math.max(0, Math.floor(rect.top - heroBox.top)),
        right: Math.min(heroBox.width, Math.ceil(rect.right - heroBox.left)),
        bottom: Math.min(heroBox.height, Math.ceil(rect.bottom - heroBox.top)),
      })));
  });
  await makeTextTransparent(copy);
  const pixels = await screenshotPixels(page, hero);
  let minimum = Number.POSITIVE_INFINITY;
  for (const rectangle of rectangles) {
    for (let y = rectangle.top; y < rectangle.bottom; y += 1) {
      for (let x = rectangle.left; x < rectangle.right; x += 1) {
        const offset = (y * pixels.width + x) * 4;
        minimum = Math.min(
          minimum,
          whiteContrast(
            pixels.data[offset] ?? 0,
            pixels.data[offset + 1] ?? 0,
            pixels.data[offset + 2] ?? 0,
          ),
        );
      }
    }
  }
  return { minimum, rectangles };
}

export async function computedStyleContrast(
  foreground: Locator,
  foregroundProperty: 'color' | 'borderTopColor' | 'outlineColor',
  background: Locator = foreground,
  backgroundProperty: 'backgroundColor' = 'backgroundColor',
) {
  const foregroundColor = await foreground.evaluate(
    (element, property) => getComputedStyle(element)[property],
    foregroundProperty,
  );
  const backgroundColor = await background.evaluate(
    (element, property) => getComputedStyle(element)[property],
    backgroundProperty,
  );
  return foreground.evaluate((_element, colors) => {
    const parse = (color: string) => {
      const [red = 0, green = 0, blue = 0] = (color.match(/[\d.]+/gu) ?? []).map(Number);
      return [red, green, blue] as const;
    };
    const linearize = (channel: number) => {
      const ratio = channel / 255;
      return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
    };
    const relativeLuminance = ([red, green, blue]: readonly number[]) =>
      0.2126 * linearize(red ?? 0) + 0.7152 * linearize(green ?? 0) + 0.0722 * linearize(blue ?? 0);
    const first = relativeLuminance(parse(colors.foregroundColor));
    const second = relativeLuminance(parse(colors.backgroundColor));
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }, { foregroundColor, backgroundColor });
}

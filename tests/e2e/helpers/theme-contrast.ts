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

export async function minimumWhiteContrast(page: Page, locator: Locator) {
  const pixels = await screenshotPixels(page, locator);
  let minimum = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    minimum = Math.min(
      minimum,
      whiteContrast(
        pixels.data[offset] ?? 0,
        pixels.data[offset + 1] ?? 0,
        pixels.data[offset + 2] ?? 0,
      ),
    );
  }
  return { minimum, width: pixels.width, height: pixels.height };
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

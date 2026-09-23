import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as printPack from '../../src/features/print/print-pack';

afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock('../../src/features/print/print-pdf'); });

const LINK = 'https://candidary.app/join#a.b';
const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function stubFonts() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    const family = url.includes('manrope') ? 'manrope' : 'dm-sans';
    const weight = family === 'manrope' ? 700 : 400;
    const bytes = readFileSync(resolve('node_modules/@fontsource', family, 'files', family + '-latin-' + weight + '-normal.woff'));
    return new Response(bytes);
  });
}

interface DrawnLine { text: string; font: string; top: number; bottom: number; left: number; right: number; width: number; height: number }

/**
 * jsdom has no canvas. This one records each line of fallback text and where its ink lands in the
 * bitmap, for marks that reach well outside the em box above, below and to the side, as stacked
 * Vietnamese marks do. Resizing resets the context, as it does in a browser.
 */
function stubCanvas(): DrawnLine[] {
  const drawn: DrawnLine[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(ONE_PIXEL_PNG);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let [width, height, sx, sy, tx, ty] = [300, 150, 1, 1, 0, 0];
    const context = {
      font: '10px sans-serif', fillStyle: '#000000', textBaseline: 'alphabetic',
      scale(x: number, y: number) { sx *= x; sy *= y; },
      translate(x: number, y: number) { tx += x * sx; ty += y * sy; },
      measureText(text: string) {
        const size = Number.parseFloat(/([\d.]+)px/u.exec(context.font)![1]!);
        const advance = [...text].length * size * .6;
        return {
          width: advance, actualBoundingBoxLeft: size * .1, actualBoundingBoxRight: advance + size * .1,
          actualBoundingBoxAscent: size * 1.3, actualBoundingBoxDescent: size * .35, emHeightAscent: size * .8, emHeightDescent: size * .2,
        };
      },
      fillText(text: string, x: number, y: number) {
        const ink = context.measureText(text);
        const baseline = context.textBaseline === 'alphabetic' ? y : context.textBaseline === 'top' ? y + ink.emHeightAscent : Number.NaN;
        drawn.push({
          text, font: context.font, width, height,
          top: (baseline - ink.actualBoundingBoxAscent) * sy + ty, bottom: (baseline + ink.actualBoundingBoxDescent) * sy + ty,
          left: (x - ink.actualBoundingBoxLeft) * sx + tx, right: (x + ink.actualBoundingBoxRight) * sx + tx,
        });
      },
    };
    const reset = () => { [sx, sy, tx, ty] = [1, 1, 0, 0]; context.font = '10px sans-serif'; context.textBaseline = 'alphabetic'; };
    Object.defineProperties(this, {
      width: { configurable: true, get: () => width, set: (value: number) => { width = value; reset(); } },
      height: { configurable: true, get: () => height, set: (value: number) => { height = value; reset(); } },
    });
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext']);
  return drawn;
}

describe('event print PDF output', () => {
  it('produces real PDFs with the chosen page size, quantity, and event title', async () => {
    expect(printPack.createPrintPdf).toBeTypeOf('function');
    stubFonts();
    const event = { name: 'Zoë & René', eventDate: '2026-09-12', eventLink: 'https://example.test/join#real-entry.secret' };
    const cards = await printPack.createPrintPdf(event, 'memorial', { kind: 'cards', style: '4x6', count: 6, paper: 'letter' });
    const pdf = await PDFDocument.load(cards);
    expect(pdf.getPageCount()).toBe(3);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(pdf.getTitle()).toContain('Zoë & René');
    const poster = await PDFDocument.load(await printPack.createPrintPdf(event, 'gathering', { kind: 'sign', size: 'poster' }));
    expect(poster.getPageCount()).toBe(1);
    expect(poster.getPage(0).getSize()).toEqual({ width: 1296, height: 1728 });
  });

  it('paints the QR in one fill however many modules the guest link needs', async () => {
    // Separately filled neighbours leave anti-aliased seams through dark areas at common render
    // resolutions, which stops standard decoders reading the code.
    stubFonts();
    async function artworkFills(eventLink: string): Promise<number> {
      const bytes = await printPack.createPrintPdf({ name: 'Zoë & René', eventDate: '2026-09-12', eventLink }, 'celebration', { kind: 'sign', size: 'letter' });
      const xobjects = (await PDFDocument.load(bytes)).getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
      const artwork = xobjects.lookup(xobjects.keys()[0]!, PDFStream);
      if (!(artwork instanceof PDFRawStream)) throw new Error('The printed artwork is not a stored PDF stream.');
      const operators = new TextDecoder().decode(decodePDFRawStream(artwork).decode());
      return operators.split(/\s+/u).filter((token) => /^(?:f\*?|F|B\*?|b\*?)$/u.test(token)).length;
    }
    const shortCode = await artworkFills('https://candidary.app/join#a.b');
    const longCode = await artworkFills('https://candidary.app/join#Ab3dEf6hIj9kLm2nOp5qRs.Tu8vWx1yZa4bCd7eFg0hIj3kLm6nOp9qRs2tUv5wXy8');
    expect(longCode).toBe(shortCode);
  });

  it('draws a name outside the bundled fonts at the heading weight with every mark inside the image', async () => {
    stubFonts();
    const drawn = stubCanvas();
    await printPack.createPrintPdf({ name: 'Nguyễn Thị Ểm', eventDate: '2026-09-12', eventLink: LINK }, 'celebration', { kind: 'cards', style: 'tent', paper: 'letter', count: 1 });
    const name = drawn.filter(({ text }) => /Nguy|Ểm/u.test(text));
    expect(name.length).toBeGreaterThan(0);
    for (const line of name) {
      expect(line.font).toMatch(/^700 /u);
      expect(line.top).toBeGreaterThanOrEqual(0);
      expect(line.bottom).toBeLessThanOrEqual(line.height);
      expect(line.left).toBeGreaterThanOrEqual(0);
      expect(line.right).toBeLessThanOrEqual(line.width);
    }
  });

  it('keeps the joiners that shape a name instead of printing them as spaces', async () => {
    stubFonts();
    const drawn = stubCanvas();
    await printPack.createPrintPdf({ name: 'مهر\u200Cآرا 👩\u200D❤\uFE0F\u200D👨', eventDate: '2026-09-12', eventLink: LINK }, 'celebration', { kind: 'sign', size: 'letter' });
    const printed = drawn.map(({ text }) => text).join('\n');
    expect(printed).toContain('مهر\u200Cآرا');
    expect(printed).toContain('👩\u200D❤\uFE0F\u200D👨');
  });

  it('wraps a long unspaced name only between whole characters', async () => {
    stubFonts();
    const drawn = stubCanvas();
    const name = 'e\u0301\u0302\u0303'.repeat(24);
    await printPack.createPrintPdf({ name, eventDate: '2026-09-12', eventLink: LINK }, 'celebration', { kind: 'stickers', layout: '22806', sheets: 1 });
    const lines = drawn.filter(({ text }) => text.includes('e\u0301')).map(({ text }) => text);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(name);
    for (const line of lines) expect(line).toMatch(/^e/u);
  });

  it('asks for a reload when this build’s font files are gone', async () => {
    // A deploy removes the previous build's hashed files, and the app shell answers for them.
    vi.stubGlobal('fetch', async () => new Response('<!doctype html><title>Candidary</title>', { headers: { 'Content-Type': 'text/html' } }));
    await expect(printPack.createPrintPdf({ name: 'Zoë & René', eventDate: '2026-09-12', eventLink: LINK }, 'celebration', { kind: 'sign', size: 'letter' }))
      .rejects.toBeInstanceOf(printPack.PrintToolsUnavailableError);
  });

  it('asks for a reload when this build’s PDF code is gone', async () => {
    vi.resetModules();
    vi.doMock('../../src/features/print/print-pdf', () => { throw new TypeError('Failed to fetch dynamically imported module'); });
    const fresh = await import('../../src/features/print/print-pack');
    await expect(fresh.createPrintPdf({ name: 'Zoë & René', eventDate: '2026-09-12', eventLink: LINK }, 'celebration', { kind: 'sign', size: 'letter' }))
      .rejects.toBeInstanceOf(fresh.PrintToolsUnavailableError);
  });

  it('refuses a management credential as the printed destination', async () => {
    expect(printPack.createPrintPdf).toBeTypeOf('function');
    await expect(printPack.createPrintPdf({ name: 'Private event', eventDate: '2026-09-12', eventLink: 'https://example.test/manage/manager-secret' }, 'celebration', { kind: 'sign', size: 'letter' }))
      .rejects.toThrow(/guest event link/i);
  });
});

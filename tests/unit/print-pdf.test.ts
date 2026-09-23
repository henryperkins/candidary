import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as printPack from '../../src/features/print/print-pack';

afterEach(() => vi.unstubAllGlobals());

function stubFonts() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    const family = url.includes('manrope') ? 'manrope' : 'dm-sans';
    const weight = family === 'manrope' ? 700 : 400;
    const bytes = readFileSync(resolve('node_modules/@fontsource', family, 'files', family + '-latin-' + weight + '-normal.woff'));
    return new Response(bytes);
  });
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

  it('refuses a management credential as the printed destination', async () => {
    expect(printPack.createPrintPdf).toBeTypeOf('function');
    await expect(printPack.createPrintPdf({ name: 'Private event', eventDate: '2026-09-12', eventLink: 'https://example.test/manage/manager-secret' }, 'celebration', { kind: 'sign', size: 'letter' }))
      .rejects.toThrow(/guest event link/i);
  });
});

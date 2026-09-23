import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as printPack from '../../src/features/print/print-pack';

afterEach(() => vi.unstubAllGlobals());

describe('event print PDF output', () => {
  it('produces real PDFs with the chosen page size, quantity, and event title', async () => {
    expect(printPack.createPrintPdf).toBeTypeOf('function');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      const family = url.includes('manrope') ? 'manrope' : 'dm-sans';
      const weight = family === 'manrope' ? 700 : 400;
      const bytes = readFileSync(resolve('node_modules/@fontsource', family, 'files', family + '-latin-' + weight + '-normal.woff'));
      return new Response(bytes);
    });
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

  it('refuses a management credential as the printed destination', async () => {
    expect(printPack.createPrintPdf).toBeTypeOf('function');
    await expect(printPack.createPrintPdf({ name: 'Private event', eventDate: '2026-09-12', eventLink: 'https://example.test/manage/manager-secret' }, 'celebration', { kind: 'sign', size: 'letter' }))
      .rejects.toThrow(/guest event link/i);
  });
});

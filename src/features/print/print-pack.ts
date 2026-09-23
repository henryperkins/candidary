/** Physical print geometry in PDF points (72 points per inch), never screen pixels. */
export const PRINT_QR_PIXELS = 2400;
export const MAX_CARDS = 40;
export const MAX_STICKER_SHEETS = 20;
export const DEFAULT_STICKER_SHEETS = 3;
export const PRINT_EXPLAINER = 'Photos go privately to the host. No app or account needed.';
export const PRINT_WORDING = {
  celebration: { label: 'Celebration', headline: 'Share the moments we missed.' },
  gathering: { label: 'Gathering', headline: 'Add your photos from today.' },
  memorial: { label: 'Memorial', headline: 'Share a photograph with the family.' },
  invitation: { label: 'Invitation', headline: 'RSVP now. Share photos on the day.' },
} as const;
export type PrintWording = keyof typeof PRINT_WORDING;
export type PrintPaper = 'letter' | 'a4';
export type CardStyle = 'tent' | '4x6' | '5x7';
export type StickerLayout = '5163' | '22806';

export const CARD_STYLES = [
  { id: 'tent', label: 'Folded tent', spec: '5 × 5½ in flat · one per sheet', per: 1 },
  { id: '4x6', label: 'Flat 4 × 6', spec: 'Fits a photo frame · two per sheet', per: 2 },
  { id: '5x7', label: 'Flat 5 × 7', spec: 'Fits a photo frame · one per sheet', per: 1 },
] as const;
export const STICKER_LAYOUTS = [
  { id: '5163', label: 'Avery 5163', spec: '2 × 4 in · ten per sheet', per: 10 },
  { id: '22806', label: 'Avery 22806', spec: '2 × 2 in · twelve per sheet', per: 12 },
] as const;

export interface PrintEvent { name: string; eventDate: string; eventLink: string }
export type PrintJob =
  | { kind: 'cards'; style: CardStyle; paper: PrintPaper; count: number }
  | { kind: 'stickers'; layout: StickerLayout; sheets: number }
  | { kind: 'sign'; size: PrintPaper | 'poster' };
export interface PrintPiece { x: number; y: number; width: number; height: number }
export interface PrintLayout {
  pageWidth: number; pageHeight: number; sheetCount: number; itemCount: number;
  cutMarks: boolean; pieces: PrintPiece[];
}

export function counted(count: number, noun: string): string {
  return String(count) + ' ' + noun + (count === 1 ? '' : 's');
}
export function clampStickerSheets(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_STICKER_SHEETS, Math.round(value))) : DEFAULT_STICKER_SHEETS;
}
export function clampCardCount(value: number, style: CardStyle): number {
  const per = style === '4x6' ? 2 : 1;
  return Math.max(per, Math.min(MAX_CARDS, Math.ceil((Number.isFinite(value) ? value : 8) / per) * per));
}

export function getPrintLayout(job: PrintJob): PrintLayout {
  if (job.kind === 'stickers') {
    const wide = job.layout === '5163';
    const sheetCount = clampStickerSheets(job.sheets);
    // Measured against Avery's own blank PDFs: avery.com/templates/5163 and /22806.
    // 22806 uses 5/8-inch margins, 2 5/8-inch column pitch, and 186-point row pitch.
    const pieces = Array.from({ length: wide ? 10 : 12 }, (_, index) => ({
      x: (wide ? 11.25 : 45) + (index % (wide ? 2 : 3)) * (wide ? 301.5 : 189),
      y: (wide ? 36 : 45) + Math.floor(index / (wide ? 2 : 3)) * (wide ? 144 : 186),
      width: wide ? 288 : 144, height: 144,
    }));
    return { pageWidth: 612, pageHeight: 792, sheetCount, itemCount: pieces.length * sheetCount, cutMarks: false, pieces };
  }
  const paper = job.kind === 'cards' ? job.paper : job.size;
  const pageWidth = paper === 'poster' ? 1296 : paper === 'a4' ? 210 * 72 / 25.4 : 612;
  const pageHeight = paper === 'poster' ? 1728 : paper === 'a4' ? 297 * 72 / 25.4 : 792;
  if (job.kind === 'sign') {
    return { pageWidth, pageHeight, sheetCount: 1, itemCount: 1, cutMarks: false,
      pieces: [{ x: 0, y: 0, width: pageWidth, height: pageHeight }] };
  }
  const per = job.style === '4x6' ? 2 : 1;
  const width = job.style === '4x6' ? 432 : 360;
  const height = job.style === '4x6' ? 288 : job.style === '5x7' ? 504 : 396;
  const itemCount = clampCardCount(job.count, job.style);
  const top = (pageHeight - (height * per + (per - 1) * 18)) / 2;
  return { pageWidth, pageHeight, sheetCount: itemCount / per, itemCount, cutMarks: true,
    pieces: Array.from({ length: per }, (_, index) => ({ x: (pageWidth - width) / 2, y: top + index * (height + 18), width, height })) };
}

export function printableLink(eventLink: string): string { return eventLink.replace(/^https?:\/\//iu, ''); }
export function printableEventDate(eventDate: string): string {
  const parsed = new Date(eventDate + 'T12:00:00');
  return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(parsed);
}

/**
 * This page's print files could not be fetched. After a deploy the previous build's hashed files are
 * gone and the app shell answers in their place, so trying again cannot help; a reload can.
 */
export class PrintToolsUnavailableError extends Error {
  constructor(cause?: unknown) { super('The print tools could not load. Reload the page, then print again.', { cause }); }
}

/** Keep the PDF renderer and font engine out of the initial Manager bundle. */
export async function createPrintPdf(event: PrintEvent, wording: PrintWording, job: PrintJob): Promise<Uint8Array<ArrayBuffer>> {
  const { renderPrintPdf } = await import('./print-pdf').catch((reason: unknown) => { throw new PrintToolsUnavailableError(reason); });
  return renderPrintPdf(event, wording, job);
}

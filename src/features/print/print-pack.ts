/**
 * The Share screen's print pack.
 *
 * Both printed pieces carry the event's one permanent entry credential, so
 * everything derived here decides how much paper the host feeds the printer and
 * nothing about what is printed on it. A pack can therefore be reprinted at any
 * time, in any quantity, without invalidating a sign already on a table.
 */

/** Avery 5163: two columns of five 2 x 4 in labels on one Letter sheet. */
export const STICKERS_PER_SHEET = 10;
export const MIN_STICKER_SHEETS = 1;
export const MAX_STICKER_SHEETS = 20;
export const DEFAULT_STICKER_SHEETS = 3;

/**
 * The code is rasterised this wide before it is placed on paper. The Share
 * screen's own 220px render is a screen artefact: a 2.3in tent code drawn from
 * it would resample its module edges, and a soft edge is a code that fails to
 * scan across a candlelit room.
 */
export const PRINT_QR_PIXELS = 1400;

export interface PrintPackSelection {
  tent: boolean;
  stickers: boolean;
  stickerSheets: number;
}

export interface PrintPackPlan {
  /** Sheets of each piece that will actually be printed. */
  tentSheets: number;
  stickerSheets: number;
  sheetCount: number;
  /** Stickers the chosen sheet count yields, whether or not stickers are selected. */
  stickerCount: number;
  stickerCountLabel: string;
  printLabel: string;
  anySelected: boolean;
  atMinSheets: boolean;
  atMaxSheets: boolean;
}

export function clampStickerSheets(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_STICKER_SHEETS;
  return Math.min(MAX_STICKER_SHEETS, Math.max(MIN_STICKER_SHEETS, Math.round(value)));
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function planPrintPack(selection: PrintPackSelection): PrintPackPlan {
  const stickerSheets = clampStickerSheets(selection.stickerSheets);
  const tentSheets = selection.tent ? 1 : 0;
  const printedStickerSheets = selection.stickers ? stickerSheets : 0;
  const sheetCount = tentSheets + printedStickerSheets;
  const stickerCount = stickerSheets * STICKERS_PER_SHEET;
  return {
    tentSheets,
    stickerSheets: printedStickerSheets,
    sheetCount,
    stickerCount,
    stickerCountLabel: counted(stickerCount, 'sticker'),
    printLabel: `Print ${counted(sheetCount, 'sheet')}`,
    anySelected: sheetCount > 0,
    atMinSheets: stickerSheets <= MIN_STICKER_SHEETS,
    atMaxSheets: stickerSheets >= MAX_STICKER_SHEETS,
  };
}

/**
 * The readable line under the code. The scheme is dropped because it is the one
 * part of the credential a guest typing it from a table never has to see, and
 * because it costs characters in the width the sticker actually has.
 */
export function printableLink(eventLink: string): string {
  return eventLink.replace(/^https?:\/\//iu, '');
}

/**
 * `Sep 12`. Both pieces name the day and never the year: the sheet is read from
 * a table at the event, where the year is the one thing nobody is checking. The
 * date is anchored at local noon exactly as the manager title anchors it, so a
 * time zone can never move it a day.
 */
export function printableEventDate(eventDate: string): string {
  const parsed = new Date(`${eventDate}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(parsed);
}

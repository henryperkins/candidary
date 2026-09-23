import fontkit from '@pdf-lib/fontkit';
import manropeUrl from '@fontsource/manrope/files/manrope-latin-700-normal.woff?url';
import dmSansUrl from '@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff?url';
import { PDFDocument, PrintScaling, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { assertGuestEventLink, qrModulePath } from './qr-artwork';
import { getPrintLayout, printableEventDate, printableLink, PRINT_EXPLAINER, PRINT_WORDING, type PrintEvent, type PrintJob, type PrintWording } from './print-pack';

const INK = rgb(74 / 255, 36 / 255, 21 / 255);
const MUTED = rgb(83 / 255, 76 / 255, 72 / 255);
const RULE = rgb(.68, .64, .60);
interface TextBox { x: number; y: number; width: number; height: number; size: number; align?: 'left' | 'center'; muted?: boolean }

async function loadFont(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The print fonts could not be loaded. Try again.');
  return response.arrayBuffer();
}

/** Wrap even a single long name or URL without clipping or silently deleting text. */
function linesFor(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.replace(/\s+/gu, ' ').trim().split(' ')) {
    const candidate = line ? line + ' ' + word : word;
    if (measure(candidate) <= width) { line = candidate; continue; }
    if (line) { lines.push(line); line = ''; }
    for (const character of word) {
      if (line && measure(line + character) > width) { lines.push(line); line = ''; }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function textBox(pdf: PDFDocument, page: PDFPage, font: PDFFont, family: string, raw: string, box: TextBox): Promise<void> {
  // Control characters have no visible print representation. Normal Unicode names remain intact.
  const text = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  const supported = new Set(font.getCharacterSet());
  const useCanvas = [...text].some((character) => !supported.has(character.codePointAt(0)!));
  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | null = null;
  if (useCanvas) {
    // System font fallback preserves names in scripts outside the bundled Latin font.
    // Only that text is rasterized; the QR remains vector in every PDF.
    await document.fonts?.ready;
    canvas = document.createElement('canvas');
    context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare the event name for printing.');
  }
  let size = box.size;
  const measure = (value: string) => {
    if (!context) return font.widthOfTextAtSize(value, size);
    context.font = size + 'px "' + family + '", sans-serif';
    return context.measureText(value).width;
  };
  let lines = linesFor(text, box.width, measure);
  while (lines.length * size * 1.22 > box.height && size > 4) {
    size -= .5;
    lines = linesFor(text, box.width, measure);
  }
  if (canvas && context) {
    const scale = 4;
    canvas.width = Math.ceil(box.width * scale);
    canvas.height = Math.ceil(box.height * scale);
    context.scale(scale, scale);
    context.font = size + 'px "' + family + '", sans-serif';
    context.fillStyle = box.muted ? '#534c48' : '#4a2415';
    context.textBaseline = 'top';
    lines.forEach((line, index) => context!.fillText(line, box.align === 'center' ? (box.width - context!.measureText(line).width) / 2 : 0, index * size * 1.22));
    const image = await pdf.embedPng(canvas.toDataURL('image/png'));
    page.drawImage(image, { x: box.x, y: page.getHeight() - box.y - box.height, width: box.width, height: box.height });
    return;
  }
  lines.forEach((line, index) => page.drawText(line, {
    x: box.x + (box.align === 'center' ? (box.width - measure(line)) / 2 : 0),
    y: page.getHeight() - box.y - size - index * size * 1.22,
    size, font, color: box.muted ? MUTED : INK,
  }));
}

function drawQr(page: PDFPage, eventLink: string, x: number, y: number, size: number): void {
  const { size: cells, path } = qrModulePath(eventLink);
  page.drawRectangle({ x, y: page.getHeight() - y - size, width: size, height: size, color: rgb(1, 1, 1) });
  // The path is in whole modules with a top-left origin; one fill keeps neighbouring modules seamless.
  page.drawSvgPath(path, { x, y: page.getHeight() - y, scale: size / cells, color: INK });
}

export async function renderPrintPdf(event: PrintEvent, wording: PrintWording, job: PrintJob): Promise<Uint8Array<ArrayBuffer>> {
  assertGuestEventLink(event.eventLink);
  const layout = getPrintLayout(job);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [headingBytes, bodyBytes] = await Promise.all([loadFont(manropeUrl), loadFont(dmSansUrl)]);
  const heading = await pdf.embedFont(headingBytes, { subset: true });
  const body = await pdf.embedFont(bodyBytes, { subset: true });
  pdf.setTitle(event.name + ' — ' + (job.kind === 'cards' ? 'Table cards' : job.kind === 'stickers' ? 'Guest QR stickers' : 'Welcome sign'));
  pdf.setCreator('Candidary');
  pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const piece = layout.pieces[0]!;
  const tent = job.kind === 'cards' && job.style === 'tent';
  const w = piece.width;
  const h = tent ? piece.height / 2 : piece.height;
  const template = pdf.addPage([w, h]);
  const title = PRINT_WORDING[wording].headline;
  const name = event.name + ' · ' + printableEventDate(event.eventDate);
  const text = (value: string, box: TextBox, bold = false) => textBox(pdf, template, bold ? heading : body, bold ? 'Manrope' : 'DM Sans', value, box);

  if (job.kind === 'stickers' && job.layout === '22806') {
    await text(event.name, { x: 10, y: 7, width: 124, height: 24, size: 9, align: 'center' }, true);
    await text(title, { x: 10, y: 32, width: 124, height: 21, size: 9, align: 'center' }, true);
    drawQr(template, event.eventLink, 36, 55, 72);
    await text('Private · No app or account needed', { x: 8, y: 130, width: 128, height: 9, size: 6.5, align: 'center', muted: true });
  } else if (job.kind === 'stickers' || tent || (job.kind === 'cards' && job.style === '4x6')) {
    const small = job.kind === 'stickers';
    const margin = small ? 12 : 18;
    const qrSize = small ? 98 : tent ? 124 : 164;
    const tx = margin + qrSize + (small ? 12 : 18);
    const tw = w - tx - margin;
    drawQr(template, event.eventLink, margin, (h - qrSize) / 2 - (small ? 5 : 0), qrSize);
    await text(name, { x: tx, y: small ? 12 : tent ? 18 : 28, width: tw, height: small ? 26 : 36, size: small ? 9 : 11 }, true);
    await text(title, { x: tx, y: small ? 43 : tent ? 62 : 86, width: tw, height: small ? 42 : tent ? 52 : 80, size: small ? 14 : tent ? 19 : 24 }, true);
    await text(PRINT_EXPLAINER, { x: tx, y: small ? 92 : tent ? 122 : 183, width: tw, height: small ? 30 : 38, size: small ? 8 : 10, muted: true });
    await text(printableLink(event.eventLink), { x: margin, y: h - (small ? 18 : 24), width: w - 2 * margin, height: small ? 15 : 20, size: small ? 6.5 : 8, align: 'center', muted: true });
  } else {
    const margin = w * .085;
    const width = w - 2 * margin;
    await text(name, { x: margin, y: h * .075, width, height: h * .12, size: w * .040, align: 'center' }, true);
    await text(title, { x: margin, y: h * .235, width, height: h * .125, size: w * .068, align: 'center' }, true);
    const qrSize = Math.min(w * .58, h * .39);
    drawQr(template, event.eventLink, (w - qrSize) / 2, h * .395, qrSize);
    await text(PRINT_EXPLAINER, { x: margin, y: h * .82, width, height: h * .08, size: w * .030, align: 'center', muted: true });
    await text(printableLink(event.eventLink), { x: margin, y: h * .925, width, height: h * .047, size: w * .018, align: 'center', muted: true });
  }

  const artwork = await pdf.embedPage(template);
  pdf.removePage(0);
  for (let index = 0; index < layout.sheetCount; index++) {
    const page = pdf.addPage([layout.pageWidth, layout.pageHeight]);
    for (const placement of layout.pieces) {
      const y = layout.pageHeight - placement.y - placement.height;
      page.drawPage(artwork, { x: placement.x, y, width: w, height: h });
      if (tent) {
        page.drawPage(artwork, { x: placement.x + w, y: y + 2 * h, width: w, height: h, rotate: degrees(180) });
        page.drawLine({ start: { x: placement.x, y: y + h }, end: { x: placement.x + w, y: y + h }, thickness: .5, color: RULE, dashArray: [2, 3] });
      }
      if (layout.cutMarks) page.drawRectangle({ x: placement.x, y, width: placement.width, height: placement.height, borderWidth: .5, borderColor: RULE, borderDashArray: [4, 3] });
    }
    if (layout.cutMarks) page.drawText(tent ? 'Actual size (100%). Cut the dashed border; fold the center line.' : 'Actual size (100%). Cut on the dashed lines.', { x: 24, y: layout.pageHeight - 20, size: 8, font: body, color: MUTED });
  }
  return new Uint8Array(await pdf.save());
}

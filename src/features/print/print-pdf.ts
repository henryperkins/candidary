import fontkit from '@pdf-lib/fontkit';
import manropeUrl from '@fontsource/manrope/files/manrope-latin-700-normal.woff?url';
import dmSansUrl from '@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff?url';
import { PDFDocument, PrintScaling, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { assertGuestEventLink, qrModulePath } from './qr-artwork';
import {
  getPrintLayout, printableEventDate, printableLink, PrintToolsUnavailableError, PRINT_EXPLAINER, PRINT_WORDING,
  type PrintEvent, type PrintJob, type PrintWording,
} from './print-pack';

const INK = rgb(74 / 255, 36 / 255, 21 / 255);
const MUTED = rgb(83 / 255, 76 / 255, 72 / 255);
const RULE = rgb(.68, .64, .60);
const WOFF_SIGNATURE = 0x774f4646;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
interface TextBox { x: number; y: number; width: number; height: number; size: number; align?: 'left' | 'center'; muted?: boolean }
interface Face { font: PDFFont; family: string; weight: number }

async function loadFont(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The print fonts could not be loaded. Try again.');
  const bytes = await response.arrayBuffer();
  // A deploy removes this build's font files, and the app shell answers for them with a 200.
  if (bytes.byteLength < 4 || new DataView(bytes).getUint32(0) !== WOFF_SIGNATURE) throw new PrintToolsUnavailableError();
  return bytes;
}

/** Wrap even a single long name or URL without clipping, deleting text, or splitting a character. */
function linesFor(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.replace(/\s+/gu, ' ').trim().split(' ')) {
    const candidate = line ? line + ' ' + word : word;
    if (measure(candidate) <= width) { line = candidate; continue; }
    if (line) { lines.push(line); line = ''; }
    for (const { segment } of graphemes.segment(word)) {
      if (line && measure(line + segment) > width) { lines.push(line); line = ''; }
      line += segment;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function textBox(pdf: PDFDocument, page: PDFPage, { font, family, weight }: Face, raw: string, box: TextBox): Promise<void> {
  // Control characters have no printed form. Format characters stay: joiners and direction marks
  // shape a name without printing, but a soft hyphen would print as a hyphen mid-word.
  const text = raw.replace(/\p{Cc}/gu, ' ').replace(/\u00AD/gu, '');
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
  const canvasFont = () => String(weight) + ' ' + String(size) + 'px "' + family + '", sans-serif';
  const measure = (value: string) => {
    if (!context) return font.widthOfTextAtSize(value, size);
    context.font = canvasFont();
    return context.measureText(value).width;
  };
  let lines = linesFor(text, box.width, measure);
  while (lines.length * size * 1.22 > box.height && size > 4) {
    size -= .5;
    lines = linesFor(text, box.width, measure);
  }
  if (canvas && context) {
    // Baselines sit where the vector text would. Marks that reach outside the em box, such as
    // stacked Vietnamese accents, widen the image around the box instead of being cut off.
    context.font = canvasFont();
    const placed = lines.map((line, index) => {
      const ink = context!.measureText(line);
      return { line, ink, x: box.align === 'center' ? (box.width - ink.width) / 2 : 0, baseline: size + index * size * 1.22 };
    });
    const left = Math.min(0, ...placed.map(({ ink, x }) => x - ink.actualBoundingBoxLeft));
    const right = Math.max(box.width, ...placed.map(({ ink, x }) => x + ink.actualBoundingBoxRight));
    const top = Math.min(0, ...placed.map(({ ink, baseline }) => baseline - ink.actualBoundingBoxAscent));
    const bottom = Math.max(box.height, ...placed.map(({ ink, baseline }) => baseline + ink.actualBoundingBoxDescent));
    const scale = 4;
    canvas.width = Math.ceil((right - left) * scale);
    canvas.height = Math.ceil((bottom - top) * scale);
    context.scale(scale, scale);
    context.font = canvasFont();
    context.fillStyle = box.muted ? '#534c48' : '#4a2415';
    context.textBaseline = 'alphabetic';
    for (const { line, x, baseline } of placed) context.fillText(line, x - left, baseline - top);
    const image = await pdf.embedPng(canvas.toDataURL('image/png'));
    page.drawImage(image, {
      x: box.x + left, y: page.getHeight() - box.y - top - canvas.height / scale,
      width: canvas.width / scale, height: canvas.height / scale,
    });
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
  const text = (value: string, box: TextBox, bold = false) => textBox(pdf, template,
    bold ? { font: heading, family: 'Manrope', weight: 700 } : { font: body, family: 'DM Sans', weight: 400 }, value, box);

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

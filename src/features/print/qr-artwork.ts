import QRCode from 'qrcode';
import { PRINT_QR_PIXELS } from './print-pack';

export const QR_MARGIN = 4;
export const QR_INK = '#4a2415';
export function assertGuestEventLink(link: string): void {
  let valid = false;
  try {
    const url = new URL(link);
    valid = ['https:', 'http:'].includes(url.protocol)
      && (/^\/join\/[^/]+$/u.test(url.pathname) || (url.pathname === '/join' && url.hash.length > 1));
  } catch { /* The event entry must be a complete URL from the manager API. */ }
  if (!valid) throw new Error('A valid guest event link is required to print.');
}
/**
 * Every dark module as one path in whole-module units, quiet zone included. Painting it in a
 * single fill lets a rasterizer cover neighbouring modules together; separately filled runs leave
 * anti-aliased seams through dark areas that stop standard decoders at common resolutions.
 */
export function qrModulePath(link: string): { size: number; path: string } {
  const { modules } = QRCode.create(link, { errorCorrectionLevel: 'M' });
  let path = '';
  for (let row = 0; row < modules.size; row++) {
    for (let column = 0; column < modules.size;) {
      if (!modules.get(row, column)) { column++; continue; }
      const start = column;
      while (column < modules.size && modules.get(row, column)) column++;
      path += 'M' + String(start + QR_MARGIN) + ' ' + String(row + QR_MARGIN) + 'h' + String(column - start) + 'v1h-' + String(column - start) + 'z';
    }
  }
  return { size: modules.size + QR_MARGIN * 2, path };
}
export async function createQrArtwork(link: string, format: 'svg' | 'png'): Promise<Blob> {
  assertGuestEventLink(link);
  const options = { margin: QR_MARGIN, errorCorrectionLevel: 'M' as const, color: { dark: QR_INK, light: '#ffffff' } };
  if (format === 'svg') return new Blob([await QRCode.toString(link, { ...options, type: 'svg' })], { type: 'image/svg+xml' });
  const data = await QRCode.toDataURL(link, { ...options, width: PRINT_QR_PIXELS });
  const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

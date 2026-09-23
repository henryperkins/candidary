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
export async function createQrArtwork(link: string, format: 'svg' | 'png'): Promise<Blob> {
  assertGuestEventLink(link);
  const options = { margin: QR_MARGIN, errorCorrectionLevel: 'M' as const, color: { dark: QR_INK, light: '#ffffff' } };
  if (format === 'svg') return new Blob([await QRCode.toString(link, { ...options, type: 'svg' })], { type: 'image/svg+xml' });
  const data = await QRCode.toDataURL(link, { ...options, width: PRINT_QR_PIXELS });
  const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

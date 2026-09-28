import type { ExportableMediaRecord } from '../db/types';
import { KNOWN_IMAGE_FORMATS,resolveImageDeclaration } from '../../shared/image-formats';

function safeBasename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot).toLowerCase().replace(/[^.a-z0-9]/gu, '') : '';
  const stem = (dot > 0 ? filename.slice(0, dot) : filename)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80) || 'photo';
  return `${stem}${extension}`;
}

/**
 * Digit width for numbering a run of this many photos: at least three, widening
 * only when the run is large enough that a 10,000th entry would otherwise sort
 * between the 100th and the 1,000th.
 */
export function exportPathWidth(mediaCount: number): number {
  return Math.max(3, String(Math.max(0, Math.trunc(mediaCount))).length);
}

/**
 * Path of one original inside its ZIP part. `globalIndex` is the photo's
 * 0-based position across the WHOLE export run, not within its part, so two
 * parts can never both contain `photos/001-…` — unzipping a multi-part export
 * into one folder must not collide and silently drop photos.
 */
export function exportPath(media: ExportableMediaRecord, globalIndex: number, width = 3): string {
  let filename=media.originalFilename;
  const declaration=resolveImageDeclaration('',media.mimeType);
  if (declaration) {
    const extensions=KNOWN_IMAGE_FORMATS[declaration.family].extensions;
    const dot=filename.lastIndexOf('.');
    if (dot <= 0 || !extensions.includes(filename.slice(dot+1).toLowerCase())) {
      filename=`${dot > 0 ? filename.slice(0,dot) : filename}.${extensions[0]}`;
    }
  }
  return `photos/${String(globalIndex + 1).padStart(width, '0')}-${safeBasename(filename)}`;
}

/**
 * R2 object key basename for one part. Deliberately NOT the self-descriptive
 * download name: `listParts`, `attemptKeys`, the `markExpired` inventory, and
 * cleanup key derivation all read this shape, and jobs already Ready keep their
 * objects exactly as written.
 */
export function exportPartName(partNumber: number): string {
  return `photos-${String(partNumber).padStart(3, '0')}.zip`;
}

/**
 * The filename a host actually receives for one part (download descriptor and
 * Content-Disposition). Carries the event identity plus the part's position and
 * the total, so a folder full of archives can be checked for completeness at a
 * glance. Folded through the same sanitizer as photo names.
 */
export function exportPartDeliveryName(
  eventDate: string,
  slug: string,
  partNumber: number,
  partCount: number,
): string {
  const width = Math.max(3, String(partCount).length);
  const part = `photos-${String(partNumber).padStart(width, '0')}-of-${String(partCount).padStart(width, '0')}.zip`;
  // Bound the event identity separately so long slugs cannot truncate the part
  // number and give every ZIP in the run the same downloaded filename.
  const identity = safeBasename(`candidary-${eventDate}-${slug}.zip`).slice(0, -4).replace(/-+$/u, '');
  return `${identity}-${part}`;
}

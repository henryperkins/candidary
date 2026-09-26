export type ImageFamily = 'jpeg' | 'png' | 'webp' | 'heic' | 'heif' | 'dng' | 'avif' | 'gif' | 'tiff' | 'bmp' | 'jp2' | 'jxl';
export type ImageDeclaration = { family: ImageFamily; mimeType: string; requiresSequence: boolean };
export type ImageEvidence = { family: ImageFamily; width: number; height: number; frameCount: number; primaryIndex: number; isSequence: boolean };
export const LEGACY_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'] as const;
export const KNOWN_IMAGE_MIME_TYPES = [...LEGACY_UPLOAD_MIME_TYPES, 'image/dng', 'image/avif', 'image/avif-sequence', 'image/gif', 'image/tiff', 'image/bmp', 'image/jp2', 'image/jxl'] as const;
export type KnownImageMimeType = (typeof KNOWN_IMAGE_MIME_TYPES)[number];
type ImageFormat = { mimeType: string; extensions: readonly string[]; aliases: readonly string[] };

// Recognition is deliberately broader than upload admission. Consumers must
// apply their own admission policy after resolving a provisional declaration.
export const KNOWN_IMAGE_FORMATS: Readonly<Record<ImageFamily, ImageFormat>> = {
  jpeg: { mimeType: 'image/jpeg', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'], aliases: ['image/jpg'] },
  png: { mimeType: 'image/png', extensions: ['png', 'apng'], aliases: ['image/x-png', 'image/apng'] },
  webp: { mimeType: 'image/webp', extensions: ['webp'], aliases: [] },
  heic: { mimeType: 'image/heic', extensions: ['heic'], aliases: ['image/x-heic'] },
  heif: { mimeType: 'image/heif', extensions: ['heif'], aliases: ['image/x-heif'] },
  dng: { mimeType: 'image/dng', extensions: ['dng'], aliases: ['image/x-adobe-dng'] },
  avif: { mimeType: 'image/avif', extensions: ['avif'], aliases: [] },
  gif: { mimeType: 'image/gif', extensions: ['gif'], aliases: [] },
  tiff: { mimeType: 'image/tiff', extensions: ['tif', 'tiff'], aliases: ['image/x-tiff'] },
  bmp: { mimeType: 'image/bmp', extensions: ['bmp'], aliases: ['image/x-ms-bmp'] },
  jp2: { mimeType: 'image/jp2', extensions: ['jp2'], aliases: ['image/jpeg2000'] },
  jxl: { mimeType: 'image/jxl', extensions: ['jxl'], aliases: [] },
};

const byMime = new Map<string, ImageDeclaration>();
const byExtension = new Map<string, ImageDeclaration>();
for (const family of Object.keys(KNOWN_IMAGE_FORMATS) as ImageFamily[]) {
  const format = KNOWN_IMAGE_FORMATS[family];
  const declaration: ImageDeclaration = { family, mimeType: format.mimeType, requiresSequence: false };
  for (const mime of [format.mimeType, ...format.aliases]) byMime.set(mime, declaration);
  for (const extension of format.extensions) byExtension.set(extension, declaration);
}
for (const family of ['heic', 'heif', 'avif'] as const) {
  const declaration: ImageDeclaration = { family, mimeType: `image/${family}-sequence`, requiresSequence: true };
  byMime.set(declaration.mimeType, declaration);
  if (family !== 'avif') byMime.set(`image/x-${family}-sequence`, declaration);
}
const genericMimeTypes = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const legacyMimeTypes = new Set<string>(LEGACY_UPLOAD_MIME_TYPES);

export function isLegacyUploadMimeType(mime: string): mime is (typeof LEGACY_UPLOAD_MIME_TYPES)[number] {
  return legacyMimeTypes.has(mime);
}

export function resolveImageDeclaration(filename: string, mime: string): ImageDeclaration | null {
  const normalized = mime.trim().toLowerCase();
  const explicit = byMime.get(normalized);
  if (explicit) return { ...explicit };
  if (!genericMimeTypes.has(normalized)) return null;
  const extension = /\.([^.\\/]+)$/u.exec(filename.trim().toLowerCase())?.[1];
  const fallback = extension ? byExtension.get(extension) : undefined;
  return fallback ? { ...fallback } : null;
}

export function imageDeclarationMatches(declared: ImageDeclaration, actual: ImageEvidence): boolean {
  const familyMatches = declared.family === actual.family || (declared.family === 'heif' && actual.family === 'heic');
  return familyMatches && (!declared.requiresSequence || actual.isSequence);
}

export function canPreviewInBrowser(family: ImageFamily): boolean {
  return family === 'jpeg' || family === 'png' || family === 'webp';
}

export const MAX_READABLE_ORIGINAL_BYTES = 5 * 1024 ** 3;
/** Storage version 26: this list/ceiling is not narrowed by intake rollback. */
export function isReadableOriginal(mimeType:string,byteSize:number):boolean {
  return Number.isSafeInteger(byteSize) && byteSize > 0 && byteSize <= MAX_READABLE_ORIGINAL_BYTES
    && (KNOWN_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

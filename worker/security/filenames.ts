const MAX_FILENAME_LENGTH = 120;

export function sanitizeFilename(input: string): string {
  const basename = input.normalize('NFKC').split(/[\\/]/u).at(-1) ?? '';
  const withoutControls = Array.from(basename)
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('');
  const cleaned = withoutControls
    .replace(/[<>:"|?*]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^\.+|\.+$/gu, '');
  const safe = cleaned || 'image';

  if (safe.length <= MAX_FILENAME_LENGTH) return safe;

  const extensionIndex = safe.lastIndexOf('.');
  const extension = extensionIndex > 0 ? safe.slice(extensionIndex, extensionIndex + 16) : '';
  return `${safe.slice(0, MAX_FILENAME_LENGTH - extension.length)}${extension}`;
}

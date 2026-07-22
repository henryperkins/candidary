export function eventSlug(name: string, suffix: string): string {
  const stem = name.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48) || 'event';
  const routeSafeSuffix = suffix.toLowerCase().replace(/[^a-z0-9]+/gu, '');
  return `${stem}-${routeSafeSuffix || 'link'}`;
}

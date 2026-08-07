/**
 * Candidary answers on more than one hostname, and both are real front doors
 * rather than one origin and one redirect. Every origin comparison in the app is
 * therefore a set membership test; an equality check against a single value is
 * what makes a second hostname render the SPA and then fail every write.
 *
 * The Worker reads its set from `APP_ORIGIN` and `ALTERNATE_ORIGINS`, so a local
 * or preview deployment answers on whatever it is configured for. The browser
 * has no bindings to read and uses the constant below; `tests/unit/origins.test.ts`
 * pins the two together against `wrangler.jsonc`.
 */
export const KNOWN_APPLICATION_ORIGINS = [
  'https://candidary.app',
  'https://candidary.online',
] as const;

/**
 * `https://Candidary.App/` and `https://candidary.app` are the same origin, and a
 * browser sends the second form in `Origin`. Normalizing both sides of every
 * comparison is what lets a configured value carry a stray trailing slash or a
 * default port without failing every write on the host that has it.
 *
 * Anything that is not an absolute `http:` or `https:` URL is not an origin, and
 * returning null rather than the input keeps a bare hostname from ever comparing
 * equal to one.
 */
export function normalizeOrigin(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * A Wrangler var is one string, so several origins arrive separated by commas or
 * whitespace. Unparseable entries are dropped rather than kept as literals: a
 * typo should cost that one origin, not turn a stray word into something an
 * `Origin` header could match.
 */
export function parseOriginList(value: string | undefined | null): string[] {
  return (value ?? '')
    .split(/[\s,]+/u)
    .map(normalizeOrigin)
    .filter((origin): origin is string => origin !== null);
}

/** The browser-side counterpart to the Worker's `isApplicationOrigin`. */
export function isKnownApplicationOrigin(value: string | undefined | null): boolean {
  const origin = normalizeOrigin(value);
  return origin !== null && (KNOWN_APPLICATION_ORIGINS as readonly string[]).includes(origin);
}

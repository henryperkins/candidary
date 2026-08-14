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

export const PREVIEW_APPLICATION_ROOT_ORIGIN =
  'https://candidary-preview.lfd.workers.dev' as const;

const PREVIEW_APPLICATION_ROOT_HOST = new URL(PREVIEW_APPLICATION_ROOT_ORIGIN).hostname;
const PREVIEW_ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,44}$/u;

const ROOT_HTTP_ORIGIN = /^https?:\/\/[^/?#\\@\s]+\/?$/iu;

/**
 * `https://Candidary.App/` and `https://candidary.app` are the same origin, and a
 * browser sends the second form in `Origin`. Normalizing both sides of every
 * comparison is what lets a configured value carry a stray trailing slash or a
 * default port without failing every write on the host that has it.
 *
 * Anything that is not an absolute, root-only `http:` or `https:` URL is not an
 * origin. Rejecting user info, paths, query strings, and fragments before taking
 * `URL.origin` prevents a malformed config entry from being silently cleaned
 * into one that compares equal to a real application origin.
 */
export function normalizeOrigin(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !ROOT_HTTP_ORIGIN.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) return null;
    return url.origin;
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

export function isPreviewApplicationOrigin(value: string | undefined | null): boolean {
  const origin = normalizeOrigin(value);
  if (origin === null) return false;
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.port) return false;
  if (url.hostname === PREVIEW_APPLICATION_ROOT_HOST) return true;
  const suffix = `-${PREVIEW_APPLICATION_ROOT_HOST}`;
  if (!url.hostname.endsWith(suffix)) return false;
  return PREVIEW_ALIAS_PATTERN.test(url.hostname.slice(0, -suffix.length));
}

export type ApplicationOriginFamily = 'production' | 'preview';

export function applicationOriginFamily(
  value: string | undefined | null,
): ApplicationOriginFamily | null {
  const origin = normalizeOrigin(value);
  if (origin === null) return null;
  if ((KNOWN_APPLICATION_ORIGINS as readonly string[]).includes(origin)) return 'production';
  if (isPreviewApplicationOrigin(origin)) return 'preview';
  return null;
}

/** The browser-side counterpart to the Worker's `isApplicationOrigin`. */
export function isKnownApplicationOrigin(value: string | undefined | null): boolean {
  return applicationOriginFamily(value) !== null;
}

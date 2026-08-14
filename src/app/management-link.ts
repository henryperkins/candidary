import { applicationOriginFamily } from '../../shared/origins';

const MANAGEMENT_PATH = /^\/manage\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

function isLoopbackDevelopmentOrigin(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === 'http:' && (
    url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
  );
}

export function parseManagementLink(value: string, currentOrigin: string): string | null {
  try {
    const origin = new URL(currentOrigin).origin;
    const parsed = new URL(value.trim(), origin);
    if (parsed.username || parsed.password) return null;
    // A sibling application origin counts only inside one deployment family.
    // Production answers on two hostnames, while isolated preview aliases share
    // preview data. A bearer path must never cross between those two families.
    //
    // Both sides have to be recognized, because this returns a pathname that the
    // caller opens on the page's own origin — and `GET /manage/:token` turns that
    // pathname into a manager session. A relative link must not make an unknown
    // page origin trusted. The only exception is a same-origin loopback server,
    // which keeps the documented local-development flow usable.
    const sameOrigin = parsed.origin === origin;
    const currentFamily = applicationOriginFamily(origin);
    if (sameOrigin) {
      if (currentFamily === null && !isLoopbackDevelopmentOrigin(origin)) return null;
    } else {
      const linkFamily = applicationOriginFamily(parsed.origin);
      if (currentFamily === null || linkFamily !== currentFamily) return null;
    }
    return MANAGEMENT_PATH.test(parsed.pathname) ? parsed.pathname : null;
  } catch {
    return null;
  }
}

// Kept beside parsing so every recovery surface takes the same final, validated
// pathname through the one browser-navigation boundary.
export function replaceManagementLocation(
  pathname: string,
  location: Pick<Location, 'replace'> = window.location,
): void {
  location.replace(pathname);
}

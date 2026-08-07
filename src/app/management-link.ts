import { isKnownApplicationOrigin } from '../../shared/origins';

const MANAGEMENT_PATH = /^\/manage\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export function parseManagementLink(value: string, currentOrigin: string): string | null {
  try {
    const origin = new URL(currentOrigin).origin;
    const parsed = new URL(value.trim(), origin);
    if (parsed.username || parsed.password) return null;
    // A sibling application origin counts. Candidary answers on more than one
    // hostname and mail always links to the canonical one, so a host who read
    // their message and then came back on the other domain is holding a link
    // that is genuinely ours and genuinely not this page's origin. Nothing
    // crosses over: only the pathname is kept, and it is opened on the origin
    // the host is already on, against the same token row either way.
    if (parsed.origin !== origin && !isKnownApplicationOrigin(parsed.origin)) return null;
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

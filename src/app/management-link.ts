import { isKnownApplicationOrigin } from '../../shared/origins';

const MANAGEMENT_PATH = /^\/manage\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export function parseManagementLink(value: string, currentOrigin: string): string | null {
  try {
    const origin = new URL(currentOrigin).origin;
    const parsed = new URL(value.trim(), origin);
    if (parsed.username || parsed.password) return null;
    // A sibling application origin counts, but only from another one. Candidary
    // answers on more than one hostname and mail always links to the canonical
    // one, so a host who read their message and came back on the other domain is
    // holding a link that is genuinely ours and genuinely not this page's origin.
    //
    // Both sides have to be recognized, because this returns a pathname that the
    // caller opens on the page's own origin — and `GET /manage/:token` turns that
    // pathname into a manager session. Accepting a production link on an
    // unrecognized host would carry a live bearer credential onto it. The Worker
    // refuses that exchange too, but the check belongs on both sides: this one
    // keeps the form from ever offering it. Same-origin recovery still works
    // everywhere, so localhost and preview hosts recover their own links.
    if (
      parsed.origin !== origin
      && (!isKnownApplicationOrigin(origin) || !isKnownApplicationOrigin(parsed.origin))
    ) return null;
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

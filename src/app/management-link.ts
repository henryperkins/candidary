const MANAGEMENT_PATH = /^\/manage\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export function parseManagementLink(value: string, currentOrigin: string): string | null {
  try {
    const origin = new URL(currentOrigin).origin;
    const parsed = new URL(value.trim(), origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) return null;
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

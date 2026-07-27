// Reading `window.localStorage` is not a safe expression on every browser a guest arrives in. iOS
// Safari with "Block All Cookies" turned on throws a SecurityError on the property access itself, and
// a full storage partition throws QuotaExceededError on the write. Either one, raised bare, takes the
// whole photo drop down with it — so remembering a name degrades to forgetting one instead.

export const GUEST_NAME_STORAGE_KEY = 'candidary_guest_name';

export function readGuestName(): string {
  try {
    return localStorage.getItem(GUEST_NAME_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function rememberGuestName(name: string): void {
  try {
    localStorage.setItem(GUEST_NAME_STORAGE_KEY, name);
  } catch {
    // The name still travels with this session's uploads; only the convenience of pre-filling the
    // next visit is lost.
  }
}

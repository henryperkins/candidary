export type ManagerSection =
  | 'intake'
  | 'rsvp'
  | 'gallery'
  | 'guestbook'
  | 'share'
  | 'settings';

export type GalleryMode = 'library' | 'album' | 'guest-gallery';

export type ManagerLocation =
  | { section: Exclude<ManagerSection, 'gallery'> }
  | { section: 'gallery'; mode: GalleryMode };

export interface ParsedManagerLocation {
  location: ManagerLocation;
  canonicalSearch: string;
  needsReplace: boolean;
  hasUnknownKeys: boolean;
  hasDuplicateKnownKeys: boolean;
}

const MANAGER_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MANAGER_PATH = /^\/manage\/event\/([^/]+)$/u;
const NON_GALLERY_SECTIONS = new Set<Exclude<ManagerSection, 'gallery'>>([
  'intake',
  'rsvp',
  'guestbook',
  'share',
  'settings',
]);
const GALLERY_MODES = new Set<GalleryMode>(['library', 'album', 'guest-gallery']);

function galleryMode(value: string | undefined): GalleryMode {
  if (value === 'shared') return 'guest-gallery';
  return value && GALLERY_MODES.has(value as GalleryMode) ? value as GalleryMode : 'library';
}

export function parseManagerLocation(search: string): ParsedManagerLocation {
  const values = { section: [] as string[], mode: [] as string[] };
  let hasUnknownKeys = false;
  for (const [key, value] of new URLSearchParams(search)) {
    if (key === 'section' || key === 'mode') values[key].push(value);
    else hasUnknownKeys = true;
  }

  const hasDuplicateKnownKeys = values.section.length > 1 || values.mode.length > 1;
  const requestedSection = values.section.length === 1 ? values.section[0] : undefined;
  const location: ManagerLocation = requestedSection === 'gallery'
    ? { section: 'gallery', mode: galleryMode(values.mode.length === 1 ? values.mode[0] : undefined) }
    : requestedSection && NON_GALLERY_SECTIONS.has(requestedSection as Exclude<ManagerSection, 'gallery'>)
      ? { section: requestedSection as Exclude<ManagerSection, 'gallery'> }
      : { section: 'intake' };
  const canonicalSearch = serializeManagerSearch(location);

  return {
    location,
    canonicalSearch,
    needsReplace: search !== canonicalSearch,
    hasUnknownKeys,
    hasDuplicateKnownKeys,
  };
}

export function serializeManagerSearch(location: ManagerLocation): string {
  const search = new URLSearchParams();
  if (location.section !== 'intake') search.set('section', location.section);
  if (location.section === 'gallery' && location.mode !== 'library') {
    search.set('mode', location.mode);
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function managerHref(eventId: string, location: ManagerLocation): string {
  return `/manage/event/${eventId}${serializeManagerSearch(location)}`;
}

export function isManagerEventId(value: string): boolean {
  return MANAGER_EVENT_ID.test(value);
}

export function managerEventIdFromPathname(pathname: string): string | null {
  const match = MANAGER_PATH.exec(pathname);
  if (!match) return null;
  const eventId = match[1]!;
  return isManagerEventId(eventId) ? eventId : null;
}

export function canonicalManagerReturnPath(value: string): {
  eventId: string;
  href: string;
} | null {
  if (
    typeof value !== 'string'
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('#')
  ) return null;

  try {
    const url = new URL(value, 'https://candidary.invalid');
    if (
      url.origin !== 'https://candidary.invalid'
      || url.username
      || url.password
      || url.hash
    ) return null;

    const eventId = managerEventIdFromPathname(url.pathname);
    if (!eventId) return null;
    const parsed = parseManagerLocation(url.search);
    if (parsed.hasUnknownKeys || parsed.hasDuplicateKnownKeys) return null;
    return { eventId, href: managerHref(eventId, parsed.location) };
  } catch {
    return null;
  }
}

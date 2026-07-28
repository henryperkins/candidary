// Where a host is sent when the credential in front of them stopped working, and
// where they are allowed to come back to afterwards.
//
// The return path is reflected off a query parameter, so it is treated as
// untrusted input: only the two local destinations that a recovery can legitimately
// end at are accepted, and anything else falls back to the account's own page. That
// keeps `returnTo` from becoming an open redirect.

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MANAGER_PATH = /^\/manage\/event\/([0-9a-f-]+)$/iu;

export const HOST_EVENTS_PATH = '/host/events';

// Built rather than concatenated at each call site, so every entry point produces
// the identical shape the login page knows how to read back.
export function hostSignInHref(eventId?: string | null): string {
  if (!eventId || !EVENT_ID.test(eventId)) return '/host/login';
  const returnTo = encodeURIComponent(`/manage/event/${eventId}`);
  return `/host/login?returnTo=${returnTo}&adopt=${eventId}`;
}

// A path is usable only if it is local, is one of the two known destinations, and —
// for a manager path — names a well-formed event.
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  if (value === HOST_EVENTS_PATH) return value;
  const manager = MANAGER_PATH.exec(value);
  return manager && EVENT_ID.test(manager[1]!) ? value : null;
}

// Adoption is only attempted for the event the host is actually returning to.
// A mismatch means the two parameters disagree, and guessing which one to trust
// would be how an unrelated event gets claimed.
export function adoptTargetFor(returnTo: string | null, adopt: string | null | undefined): string | null {
  if (!adopt || !EVENT_ID.test(adopt) || !returnTo) return null;
  return MANAGER_PATH.exec(returnTo)?.[1]?.toLowerCase() === adopt.toLowerCase() ? adopt : null;
}

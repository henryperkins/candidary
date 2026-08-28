// Where a host is sent when the credential in front of them stopped working, and
// where they are allowed to come back to afterwards.
//
// The return path is reflected off a query parameter, so it is treated as
// untrusted input: only the two local destinations that a recovery can legitimately
// end at are accepted, and anything else falls back to the account's own page. That
// keeps `returnTo` from becoming an open redirect.

import { canonicalManagerReturnPath, isManagerEventId } from './manager-location';

export const HOST_EVENTS_PATH = '/host/events';

// Confirmation can resume only the Manager destination checked by the shared
// Manager-location contract. Every other successful confirmation ends at the
// account's event list; no raw query value becomes a navigation target.
export function registrationConfirmationDestination({
  boundEvent,
  returnTo,
  validatedAdopt,
}: {
  boundEvent: boolean;
  returnTo: string | null | undefined;
  /** The already-validated result of adoptTargetFor for this return context. */
  validatedAdopt: string | null | undefined;
}): string {
  if (!boundEvent || !returnTo || !validatedAdopt) return HOST_EVENTS_PATH;
  return canonicalManagerReturnPath(returnTo)?.href ?? HOST_EVENTS_PATH;
}

// A path is usable only if it is the host's event list or a canonical Manager
// destination. Manager validation and normalization belong to its shared contract.
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value === HOST_EVENTS_PATH) return value;
  return canonicalManagerReturnPath(value)?.href ?? null;
}

// Adoption is only attempted for the event the host is actually returning to.
// A mismatch means the two parameters disagree, and guessing which one to trust
// would be how an unrelated event gets claimed.
export function adoptTargetFor(returnTo: string | null, adopt: string | null | undefined): string | null {
  if (!adopt || !isManagerEventId(adopt) || !returnTo) return null;
  const eventId = canonicalManagerReturnPath(returnTo)?.eventId;
  return eventId?.toLowerCase() === adopt.toLowerCase() ? adopt : null;
}

function hostRecoveryHref(
  path: '/host/login' | '/host/register',
  eventId?: string | null,
  returnTo?: string | null,
  pending = false,
): string {
  const validEventId = eventId && isManagerEventId(eventId) ? eventId : null;
  // A valid manager event supplies its own safe return destination. Otherwise a
  // caller may only keep a separately validated path; raw query state never wins.
  const safeDestination = safeReturnTo(returnTo)
    ?? (validEventId ? `/manage/event/${validEventId}` : null);
  const adopt = adoptTargetFor(safeDestination, validEventId);
  const search = new URLSearchParams();
  if (safeDestination) search.set('returnTo', safeDestination);
  if (adopt) search.set('adopt', adopt);
  if (pending) search.set('pending', '1');
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

// Built rather than concatenated at each call site, so every entry point produces
// the identical shape the login page knows how to read back.
export function hostSignInHref(eventId?: string | null, returnTo?: string | null): string {
  return hostRecoveryHref('/host/login', eventId, returnTo);
}

// The pending bit is only a presentation hint for resuming a registration cookie;
// it does not make an event claim valid and the server still resolves that claim.
export function hostRegisterHref(eventId?: string | null, returnTo?: string | null, pending = false): string {
  return hostRecoveryHref('/host/register', eventId, returnTo, pending);
}

import type { EventView, GuestEventView } from '../../shared/contracts';
import { localDateForInstant } from '../../shared/event-time';
import { resolvedThemeView } from '../../shared/event-theme';
import { resolveGuestEventPhase } from '../../shared/rsvp';
import type { EventRecord } from '../db/types';

function deadlineDate(event: EventRecord): string | null {
  return event.rsvpDeadlineAt
    ? localDateForInstant(event.rsvpDeadlineAt, event.eventTimezone)
    : null;
}

export function eventView(event: EventRecord): EventView {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    eventDate: event.eventDate,
    welcomeMessage: event.welcomeMessage,
    coverObjectKey: event.coverObjectKey,
    uploadsEnabled: event.uploadsEnabled,
    galleryVisible: event.galleryVisible,
    moderationRequired: event.moderationRequired,
    reservedMediaCount: event.reservedMediaCount,
    storedMediaCount: event.storedMediaCount,
    reservedBytes: event.reservedBytes,
    storedBytes: event.storedBytes,
    guestAccessExpiresAt: event.guestAccessExpiresAt,
    managementAccessExpiresAt: event.managementAccessExpiresAt,
    purgeAfter: event.purgeAfter,
    createdAt: event.createdAt,
    deletedAt: event.deletedAt,
    eventTimezone: event.eventTimezone,
    rsvpEnabled: event.rsvpEnabled,
    rsvpDeadlineAt: event.rsvpDeadlineAt,
    rsvpDeadlineDate: deadlineDate(event),
    rsvpRosterVersion: event.rsvpRosterVersion,
    theme: resolvedThemeView(event.themeConfig),
  };
}

/**
 * What a guest is allowed to see, plus the phase the server decided.
 *
 * `now` is a parameter so the boundary is testable to the millisecond, and so
 * every field in one response is derived from a single instant. The browser is
 * never asked to compare the deadline to its own clock.
 */
export function guestEventView(event: EventRecord, now = new Date()): GuestEventView {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    eventDate: event.eventDate,
    welcomeMessage: event.welcomeMessage,
    coverObjectKey: event.coverObjectKey,
    uploadsEnabled: event.uploadsEnabled,
    galleryVisible: event.galleryVisible,
    moderationRequired: event.moderationRequired,
    eventTimezone: event.eventTimezone,
    rsvpDeadlineAt: event.rsvpDeadlineAt,
    rsvpDeadlineDate: deadlineDate(event),
    ...resolveGuestEventPhase(event, now),
    theme: resolvedThemeView(event.themeConfig),
  };
}

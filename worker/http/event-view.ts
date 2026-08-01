import type { EventView, GuestEventView } from '../../shared/contracts';
import {
  localDateForInstant,
  localTimeForInstant,
} from '../../shared/event-time';
import { resolvedThemeView } from '../../shared/event-theme';
import { isLegacyEventStart, resolveGuestEventPhase, resolvePhotoIntake } from '../../shared/rsvp';
import type { EventRecord } from '../db/types';

function deadlineDate(event: EventRecord): string | null {
  return event.rsvpDeadlineAt
    ? localDateForInstant(event.rsvpDeadlineAt, event.eventTimezone)
    : null;
}

/**
 * The host's own start time, as they typed it.
 *
 * A migration-sentinel row has no trustworthy start, so the settings form is
 * seeded with the documented default rather than with the epoch rendered in the
 * event's zone — which would be a real-looking time nobody chose.
 */
function startTime(event: EventRecord): string {
  if (isLegacyEventStart(event.eventStartAt)) return '00:00';
  return localTimeForInstant(event.eventStartAt, event.eventTimezone);
}

export function eventView(event: EventRecord, now = new Date()): EventView {
  const intake = resolvePhotoIntake(event, now);
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
    eventStartAt: event.eventStartAt,
    eventStartTime: startTime(event),
    photosOpen: intake.photosOpen,
    photoIntakeState: intake.photoIntakeState,
    photoIntakeRecheckAfterMs: intake.photoIntakeRecheckAfterMs,
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
 * never asked to compare the deadline, or the start, to its own clock.
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
    eventStartAt: event.eventStartAt,
    rsvpDeadlineAt: event.rsvpDeadlineAt,
    rsvpDeadlineDate: deadlineDate(event),
    ...resolveGuestEventPhase(event, now),
    theme: resolvedThemeView(event.themeConfig),
  };
}

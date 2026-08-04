import type { EventView, GuestEventView } from '../../shared/contracts';
import type { EventCoverPreparationView } from '../../shared/event-cover';
import {
  localDateForInstant,
  localTimeForInstant,
} from '../../shared/event-time';
import { resolvedThemeView } from '../../shared/event-theme';
import {
  isLegacyEventStart,
  isRsvpConfigured,
  resolveGuestEventPhase,
  resolvePhotoIntake,
} from '../../shared/rsvp';
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

/**
 * The one place the presence sentinel is introduced.
 *
 * `cover_object_key` now holds a private normalized master for a published
 * upload, so projecting the column would be worse than the status quo: it would
 * hand out the key of a high-resolution original rather than a legacy one. Both
 * audiences use this field for presence only and then request the authorized
 * route, so a constant truthy value says everything either of them needs.
 *
 * It belongs here and not in `mapEvent`, because delivery reads
 * `auth.event.coverObjectKey` from the record — sentinelling there would make
 * the cover route fetch an object literally named `cover-present`.
 */
const COVER_PRESENT_SENTINEL = 'cover-present';

function coverPresence(event: EventRecord): string | null {
  return event.coverObjectKey || event.coverRenderSetId ? COVER_PRESENT_SENTINEL : null;
}

export function eventView(
  event: EventRecord,
  now = new Date(),
  // Resolved by the caller and passed in, because it needs a D1 read and this
  // projection stays pure and synchronous. The default keeps all eight existing
  // call sites compiling.
  coverPreparation: EventCoverPreparationView | null = null,
): EventView {
  const intake = resolvePhotoIntake(event, now);
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    eventDate: event.eventDate,
    welcomeMessage: event.welcomeMessage,
    coverObjectKey: coverPresence(event),
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
    coverPreparation,
    coverRevision: event.coverRevision,
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
  const rsvpConfigured = isRsvpConfigured(event);
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    eventDate: event.eventDate,
    welcomeMessage: event.welcomeMessage,
    coverObjectKey: coverPresence(event),
    uploadsEnabled: event.uploadsEnabled,
    galleryVisible: event.galleryVisible,
    moderationRequired: event.moderationRequired,
    eventTimezone: event.eventTimezone,
    eventStartAt: event.eventStartAt,
    rsvpDeadlineAt: event.rsvpDeadlineAt,
    rsvpDeadlineDate: deadlineDate(event),
    ...resolveGuestEventPhase({ ...event, rsvpConfigured }, now),
    theme: resolvedThemeView(event.themeConfig),
  };
}

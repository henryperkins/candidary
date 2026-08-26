import type { EventView, GuestEventView } from '../../shared/contracts';
import type { EventCoverView, GuestEventCoverView } from '../../shared/event-cover';
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
import type { AppEnv } from '../env';
import { selectEventCoverPreparation } from '../services/event-cover-publication';
import {
  guestCoverView,
  selectManagerEventCoverView,
} from './event-cover-view';

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
export function eventStartTime(event: EventRecord): string {
  if (isLegacyEventStart(event.eventStartAt)) return '00:00';
  return localTimeForInstant(event.eventStartAt, event.eventTimezone);
}

export function eventView(
  event: EventRecord,
  cover: EventCoverView,
  now = new Date(),
): EventView {
  const intake = resolvePhotoIntake(event, now);
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    eventDate: event.eventDate,
    welcomeMessage: event.welcomeMessage,
    guestbookPrompt: event.guestbookPrompt,
    cover,
    uploadsEnabled: event.uploadsEnabled,
    galleryVisible: event.galleryVisible,
    moderationRequired: event.moderationRequired,
    reservedMediaCount: event.reservedMediaCount,
    storedMediaCount: event.storedMediaCount,
    reservedBytes: event.reservedBytes,
    storedBytes: event.storedBytes,
    recoverableMediaCount: event.recoverableMediaCount,
    recoverableBytes: event.recoverableBytes,
    guestAccessExpiresAt: event.guestAccessExpiresAt,
    managementAccessExpiresAt: event.managementAccessExpiresAt,
    purgeAfter: event.purgeAfter,
    createdAt: event.createdAt,
    deletedAt: event.deletedAt,
    eventTimezone: event.eventTimezone,
    eventStartAt: event.eventStartAt,
    eventStartTime: eventStartTime(event),
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
export function guestEventView(
  event: EventRecord,
  cover: GuestEventCoverView,
  now = new Date(),
): GuestEventView {
  const rsvpConfigured = isRsvpConfigured(event);
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    eventDate: event.eventDate,
    welcomeMessage: event.welcomeMessage,
    guestbookPrompt: event.guestbookPrompt,
    cover,
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

/** Route boundary: load the manager-only preparation and capability together. */
export async function selectManagerEventView(
  env: AppEnv,
  event: EventRecord,
  now = new Date(),
): Promise<EventView> {
  const preparation = await selectEventCoverPreparation(env, event.id, now);
  const cover = await selectManagerEventCoverView(env.DB, event, preparation);
  return eventView(event, cover, now);
}

/** Route boundary: derive the manager projection, then apply the guest allowlist. */
export async function selectGuestEventView(
  db: D1Database,
  event: EventRecord,
  now = new Date(),
): Promise<GuestEventView> {
  const cover = await selectManagerEventCoverView(db, event, null);
  return guestEventView(event, guestCoverView(cover), now);
}

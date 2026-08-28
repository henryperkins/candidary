import type { EventView, GuestEventView } from '../../shared/contracts';
import { MAX_EVENT_BYTES, MAX_EVENT_MEDIA } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import type { EventCoverView, GuestEventCoverView } from '../../shared/event-cover';
import {
  localDateForInstant,
  localTimeForInstant,
} from '../../shared/event-time';
import { resolvedThemeView } from '../../shared/event-theme';
import {
  isLegacyEventStart,
  isRsvpConfigured,
  GUEST_READ_SURFACES_UNAVAILABLE_MESSAGE,
  resolveGuestEventPhase,
  resolvePhotoIntake,
} from '../../shared/rsvp';
import type { EventRecord } from '../db/types';
import { TokensRepository } from '../db/tokens';
import type { AppEnv } from '../env';
import { selectEventCoverPreparation } from '../services/event-cover-publication';
import {
  guestCoverView,
  selectManagerEventCoverView,
} from './event-cover-view';

type ManagerLinkProjection = Pick<
  EventView,
  'managerLinkRevision' | 'managerLinkRotationAvailability'
>;

function resolveGuestPhaseForEvent(event: EventRecord, now: Date) {
  return resolveGuestEventPhase({
    ...event,
    rsvpConfigured: isRsvpConfigured(event),
  }, now);
}

function guestReadSurfacesConflict(): ApiError {
  return new ApiError(
    'EVENT_PHASE_CONFLICT',
    GUEST_READ_SURFACES_UNAVAILABLE_MESSAGE,
    409,
  );
}

/** One route guard owns the direct Gallery, My Deliveries, and Guestbook refusal. */
export function assertGuestReadSurfacesAvailable(
  event: EventRecord,
  now = new Date(),
): void {
  if (!resolveGuestPhaseForEvent(event, now).guestReadSurfaces.available) {
    throw guestReadSurfacesConflict();
  }
}

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

function hostUploadAvailability(event: EventRecord): EventView['hostUploadAvailability'] {
  const retainedMedia = event.storedMediaCount
    + event.reservedMediaCount
    + event.recoverableMediaCount;
  if (retainedMedia >= MAX_EVENT_MEDIA) {
    return { enabled: false, reason: 'media-cap' };
  }

  const retainedBytes = event.storedBytes + event.reservedBytes + event.recoverableBytes;
  if (retainedBytes >= MAX_EVENT_BYTES) {
    return { enabled: false, reason: 'storage-cap' };
  }

  return { enabled: true, reason: null };
}

export function eventView(
  event: EventRecord,
  cover: EventCoverView,
  now = new Date(),
  managerLink: ManagerLinkProjection = {
    managerLinkRevision: null,
    managerLinkRotationAvailability: { enabled: false, reason: 'account-required' },
  },
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
    hostUploadAvailability: hostUploadAvailability(event),
    guestAccessExpiresAt: event.guestAccessExpiresAt,
    managementAccessExpiresAt: event.managementAccessExpiresAt,
    ...managerLink,
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
    ...resolveGuestPhaseForEvent(event, now),
    theme: resolvedThemeView(event.themeConfig),
  };
}

/** Route boundary: load the manager-only preparation and capability together. */
export async function selectManagerEventView(
  env: AppEnv,
  event: EventRecord,
  now = new Date(),
  via: 'link' | 'account' | null = null,
): Promise<EventView> {
  const preparation = await selectEventCoverPreparation(env, event.id, now);
  const cover = await selectManagerEventCoverView(env.DB, event, preparation);
  const managerLink: ManagerLinkProjection = via === 'account'
    ? {
        managerLinkRevision: await new TokensRepository(env.DB).getManagerLinkRevision(event.id),
        managerLinkRotationAvailability: { enabled: true, reason: null },
      }
    : {
        managerLinkRevision: null,
        managerLinkRotationAvailability: { enabled: false, reason: 'account-required' },
      };
  return eventView(event, cover, now, managerLink);
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

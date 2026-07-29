import type { EventView, GuestEventView } from '../../shared/contracts';
import { resolvedThemeView } from '../../shared/event-theme';
import type { EventRecord } from '../db/types';

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
    theme: resolvedThemeView(event.themeConfig),
  };
}

export function guestEventView(event: EventRecord): GuestEventView {
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
    theme: resolvedThemeView(event.themeConfig),
  };
}

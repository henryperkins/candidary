import { api } from '../../app/api';
import type {
  AlbumEntryInput,
  AlbumEntryView,
  AlbumView,
  ManagerGalleryMediaView,
} from '../../../shared/contracts';

function albumPath(eventId: string, suffix = ''): string {
  return `/api/manage/events/${eventId}/album${suffix}`;
}

export function fetchAlbum(eventId: string, signal?: AbortSignal): Promise<{ album: AlbumView }> {
  return api<{ album: AlbumView }>(albumPath(eventId), signal ? { signal } : {});
}

/**
 * Sends the arrangement whole. Reorder, add a section, rename one and remove one are the
 * same request, so a failure leaves the stored order exactly as it was rather than
 * half-applied — and the revision it was composed against travels with it.
 */
export function saveAlbumOrder(
  eventId: string,
  revision: number,
  entries: AlbumEntryInput[],
): Promise<{ album: AlbumView }> {
  return api<{ album: AlbumView }>(albumPath(eventId), {
    method: 'PUT',
    body: JSON.stringify({ revision, entries }),
  });
}

export function setAlbumPicks(
  eventId: string,
  mediaIds: readonly string[],
  picked: boolean,
): Promise<{ changed: ManagerGalleryMediaView[] }> {
  return api<{ changed: ManagerGalleryMediaView[] }>(albumPath(eventId, '/picks'), {
    method: 'POST',
    body: JSON.stringify({ mediaIds: [...mediaIds], picked }),
  });
}

export function startAlbum(
  eventId: string,
  start: 'from-picks' | 'empty',
): Promise<{ album: AlbumView; cleared: string[] }> {
  return api<{ album: AlbumView; cleared: string[] }>(albumPath(eventId, '/start'), {
    method: 'POST',
    body: JSON.stringify({ start }),
  });
}

/** The wire shape of what is on screen, so a save sends the order the host is looking at. */
export function toEntryInput(entries: readonly AlbumEntryView[]): AlbumEntryInput[] {
  return entries.map((entry) => (
    entry.kind === 'section'
      ? { kind: 'section' as const, id: entry.id, heading: entry.heading }
      : { kind: 'photo' as const, mediaId: entry.photo.id }
  ));
}

/**
 * Moves one entry by one position and returns a new list.
 *
 * Deliberately a plain swap rather than "move past the next photo": a section is a real
 * position, so stepping a photo over a heading moves it into the previous section, which
 * is the only way a host can put a photo *under* a heading using buttons alone.
 */
export function moveEntry<T>(entries: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= entries.length || target < 0 || target >= entries.length) {
    return [...entries];
  }
  const next = [...entries];
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

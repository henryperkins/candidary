import { api } from '../../app/api';
import type {
  AlbumEntryInput,
  AlbumEntryView,
  AlbumMetadataInput,
  AlbumReconciliation,
  AlbumSaveRequest,
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
  metadata?: AlbumMetadataInput,
): Promise<{ album: AlbumView }> {
  const request = { revision, entries, metadata } satisfies AlbumSaveRequest;
  return api<{ album: AlbumView }>(albumPath(eventId), {
    method: 'PUT',
    body: JSON.stringify(request),
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

/**
 * The complete Album projection needed to classify one inverse safely.
 *
 * Entries are the serialized write shape, not UI rows: equality therefore covers
 * section identity, headings, photo membership, and order without retaining a
 * component-owned draft or operation queue.
 */
export interface AlbumInverseState {
  readonly revision: number;
  readonly saved: boolean;
  readonly entries: readonly AlbumEntryInput[];
  readonly title: string;
  readonly description: string;
  readonly coverMediaId: string | null;
}

export type AlbumInversePayload =
  | {
    readonly kind: 'order';
    readonly forward: AlbumInverseState;
    readonly restored: AlbumInverseState;
  }
  | {
    readonly kind: 'membership';
    readonly mediaIds: readonly string[];
    readonly forward: AlbumInverseState;
    readonly restored: AlbumInverseState;
  }
  | {
    readonly kind: 'membership-order';
    readonly mediaIds: readonly string[];
    readonly forward: AlbumInverseState;
    readonly membershipRestored: AlbumInverseState;
    readonly restored: AlbumInverseState;
  };

export interface AlbumStartRequest {
  start: 'from-picks' | 'empty';
  expectedReconciliation: Exclude<AlbumReconciliation, null>['kind'];
  expectedPickGeneration: number;
  expectedRevision: number;
}

export function startAlbum(
  eventId: string,
  request: AlbumStartRequest,
): Promise<{ album: AlbumView; started: boolean; cleared: string[] }> {
  return api<{ album: AlbumView; started: boolean; cleared: string[] }>(albumPath(eventId, '/start'), {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

/**
 * The wire shape of what is on screen, so a save sends the order the host is looking at.
 *
 * A retained slot round-trips as an ordinary photo entry, because that is exactly
 * what it is — the same media id, in the same position, whose row happens to be in
 * Recently deleted. Dropping it here is how an ordinary reorder would silently
 * evict a photo the host can still restore.
 */
export function toEntryInput(entries: readonly AlbumEntryView[]): AlbumEntryInput[] {
  return entries.map((entry) => {
    if (entry.kind === 'section') {
      return { kind: 'section' as const, id: entry.id, heading: entry.heading };
    }
    return {
      kind: 'photo' as const,
      mediaId: entry.kind === 'photo-retained' ? entry.slot.mediaId : entry.photo.id,
    };
  });
}

function albumMatchesInverseState(album: AlbumView, state: AlbumInverseState): boolean {
  return album.revision === state.revision
    && album.saved === state.saved
    && album.title === state.title
    && album.description === state.description
    && album.coverMediaId === state.coverMediaId
    && JSON.stringify(toEntryInput(album.entries)) === JSON.stringify(state.entries);
}

function inverseConflict(): Error {
  return new Error('The Album changed before Undo could finish. Reload the Album and try again.');
}

function restoredEntries(state: AlbumInverseState): AlbumEntryInput[] {
  return state.entries.map((entry) => ({ ...entry }));
}

function restoredMetadata(state: AlbumInverseState): AlbumMetadataInput {
  return {
    title: state.title,
    description: state.description,
    coverMediaId: state.coverMediaId,
  };
}

async function verifyReturnedOrFetchedAlbum(
  eventId: string,
  returned: { album: AlbumView },
  restored: AlbumInverseState,
): Promise<{ album: AlbumView }> {
  if (albumMatchesInverseState(returned.album, restored)) return returned;
  const fetched = await fetchAlbum(eventId);
  if (albumMatchesInverseState(fetched.album, restored)) return fetched;
  throw inverseConflict();
}

/**
 * Runs one mount-independent Album inverse against canonical state.
 *
 * Each phase is classified before its write. A retry can therefore resume after
 * accepted membership or order requests whose responses were lost, while any
 * unrelated Album change fails closed instead of overwriting newer host work.
 */
export async function runAlbumInverse(
  eventId: string,
  payload: AlbumInversePayload,
): Promise<{ album: AlbumView }> {
  let current = await fetchAlbum(eventId);
  if (albumMatchesInverseState(current.album, payload.restored)) return current;

  if (payload.kind === 'order') {
    if (!albumMatchesInverseState(current.album, payload.forward)) throw inverseConflict();
    const returned = await saveAlbumOrder(
      eventId,
      current.album.revision,
      restoredEntries(payload.restored),
      restoredMetadata(payload.restored),
    );
    return verifyReturnedOrFetchedAlbum(eventId, returned, payload.restored);
  }

  if (payload.kind === 'membership') {
    if (!albumMatchesInverseState(current.album, payload.forward)) throw inverseConflict();
    await setAlbumPicks(eventId, payload.mediaIds, true);
    current = await fetchAlbum(eventId);
    if (albumMatchesInverseState(current.album, payload.restored)) return current;
    throw inverseConflict();
  }

  if (albumMatchesInverseState(current.album, payload.forward)) {
    await setAlbumPicks(eventId, payload.mediaIds, true);
    current = await fetchAlbum(eventId);
    if (albumMatchesInverseState(current.album, payload.restored)) return current;
  }

  if (!albumMatchesInverseState(current.album, payload.membershipRestored)) {
    throw inverseConflict();
  }

  const returned = await saveAlbumOrder(
    eventId,
    current.album.revision,
    restoredEntries(payload.restored),
    restoredMetadata(payload.restored),
  );
  return verifyReturnedOrFetchedAlbum(eventId, returned, payload.restored);
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

export function moveEntryTo<T>(entries: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= entries.length || to >= entries.length || from === to) {
    return [...entries];
  }
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

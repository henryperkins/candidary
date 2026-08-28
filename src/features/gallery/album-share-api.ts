import type {
  AlbumShareStatus,
  AlbumShareView,
  PublicAlbumView,
} from '../../../shared/contracts';
import { api } from '../../app/api';

function managerSharePath(eventId: string): string {
  return `/api/manage/events/${encodeURIComponent(eventId)}/album/share`;
}

export function fetchAlbumShare(
  eventId: string,
  signal?: AbortSignal,
): Promise<{ share: AlbumShareStatus }> {
  return api<{ share: AlbumShareStatus }>(
    managerSharePath(eventId),
    signal ? { signal } : {},
  );
}

export function shareAlbum(eventId: string): Promise<{ share: AlbumShareView }> {
  return api<{ share: AlbumShareView }>(managerSharePath(eventId), { method: 'POST' });
}

export function stopAlbumShare(eventId: string): Promise<{ share: null }> {
  return api<{ share: null }>(managerSharePath(eventId), { method: 'DELETE' });
}

export function exchangeAlbumShare(
  token: string,
  signal?: AbortSignal,
): Promise<{ album: PublicAlbumView }> {
  return api<{ album: PublicAlbumView }>('/api/album-share/exchange', {
    method: 'POST',
    body: JSON.stringify({ token }),
    ...(signal ? { signal } : {}),
  });
}

export function fetchPublicAlbum(signal?: AbortSignal): Promise<{ album: PublicAlbumView }> {
  return api<{ album: PublicAlbumView }>(
    '/api/album-share',
    signal ? { signal } : {},
  );
}

export function publicAlbumPreview(mediaId: string): string {
  return `/api/album-share/media/${encodeURIComponent(mediaId)}/preview`;
}

function managerAlbumPath(eventId: string): string {
  return `/api/manage/events/${encodeURIComponent(eventId)}/album`;
}

/**
 * Manager Preview is not sharing.
 *
 * It reads the same public projection through ordinary Manager authentication, so a host can see
 * exactly what a recipient would see before a link has ever existed, after one was stopped, and
 * with nothing picked yet. It asks nothing of the share status, exchanges no fragment, touches no
 * album-share cookie, and carries back no link, token, or ciphertext.
 */
export function fetchManagerAlbumPreview(
  eventId: string,
  signal?: AbortSignal,
): Promise<{ album: PublicAlbumView }> {
  return api<{ album: PublicAlbumView }>(
    `${managerAlbumPath(eventId)}/preview`,
    signal ? { signal } : {},
  );
}

/** The Manager-authenticated twin of `publicAlbumPreview`, for the same bytes. */
export function managerAlbumPreviewImage(eventId: string, mediaId: string): string {
  return `${managerAlbumPath(eventId)}/media/${encodeURIComponent(mediaId)}/preview`;
}

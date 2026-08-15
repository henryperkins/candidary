import { ChevronLeft, ChevronRight, Heart, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { mediaPreview } from '../../app/api';
import type { ManagerGalleryMediaView } from '../../../shared/contracts';
import { formatMomentHeading, galleryPhotoTitle } from './gallery-timeline';

interface GalleryViewerProps {
  photos: ManagerGalleryMediaView[];
  index: number;
  timeZone: string;
  /** Whether the timeline still has unloaded pages behind the loaded result set. */
  hasMore: boolean;
  favoritePendingIds: ReadonlySet<string>;
  onIndexChange(index: number): void;
  onClose(): void;
  onFavorite(photo: ManagerGalleryMediaView): void;
}

/**
 * The viewer navigates the loaded result set and nothing else, so its position line says so while
 * pages remain. The header's event total counts every stored photo; a bare "of 48" beside "842
 * photos" would read as a second, smaller collection rather than as one page of the first.
 */
function positionLabel(index: number, count: number, hasMore: boolean): string {
  return hasMore
    ? `Photo ${index + 1} of ${count} loaded`
    : `Photo ${index + 1} of ${count}`;
}

export function GalleryViewer({
  photos,
  index,
  timeZone,
  hasMore,
  favoritePendingIds,
  onIndexChange,
  onClose,
  onFavorite,
}: GalleryViewerProps) {
  const photo = photos[index];
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowRight' && index < photos.length - 1) {
        event.preventDefault();
        onIndexChange(index + 1);
        return;
      }
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault();
        onIndexChange(index - 1);
        return;
      }
      if (event.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, a[href], [tabindex]:not([tabindex="-1"])',
        );
        const first = focusable?.[0];
        const last = focusable?.[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [index, photos.length, onClose, onIndexChange]);

  if (!photo) return null;
  const title = galleryPhotoTitle(photo);
  const titleId = `gallery-viewer-title-${photo.id}`;
  const moment = {
    key: photo.id,
    photos: [photo],
    startAt: photo.timelineAt,
    endAt: photo.timelineAt,
  };
  return <div
    className="gallery-viewer"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    ref={dialogRef}
  >
    <button type="button" className="gallery-viewer__close" ref={closeRef} aria-label="Close viewer" onClick={onClose}>
      <X aria-hidden="true" />
    </button>
    <button
      type="button"
      className="gallery-viewer__prev"
      disabled={index === 0}
      aria-label="Previous photo"
      onClick={() => onIndexChange(index - 1)}
    >
      <ChevronLeft aria-hidden="true" />
    </button>
    <div className="gallery-viewer__media">
      {photo.previewAvailable
        ? <img src={mediaPreview(photo.id)} alt={title} decoding="async" />
        : <div className="gallery-viewer__placeholder"><strong>{photo.originalFilename}</strong><span>Preview unavailable</span></div>}
    </div>
    <button
      type="button"
      className="gallery-viewer__next"
      disabled={index >= photos.length - 1}
      aria-label="Next photo"
      onClick={() => onIndexChange(index + 1)}
    >
      <ChevronRight aria-hidden="true" />
    </button>
    <div className="gallery-viewer__info">
      <div className="gallery-viewer__meta">
        <strong id={titleId}>{title}</strong>
        <span>From {photo.guestName}</span>
        <span className="gallery-viewer__timing">
          {photo.timelineSource === 'capture' ? 'Taken' : 'Received'} {formatMomentHeading(moment, timeZone)}
        </span>
        <span className="gallery-viewer__position">{positionLabel(index, photos.length, hasMore)}</span>
      </div>
      <button
        type="button"
        className="gallery-viewer__favorite"
        aria-pressed={photo.isFavorite}
        aria-label={`Favorite ${title}`}
        disabled={favoritePendingIds.has(photo.id)}
        onClick={() => onFavorite(photo)}
      >
        <Heart aria-hidden="true" fill={photo.isFavorite ? 'currentColor' : 'none'} /> Favorite
      </button>
    </div>
  </div>;
}

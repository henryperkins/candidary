import { ChevronLeft, ChevronRight, Heart, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { mediaPreview } from '../../app/api';
import type { ManagerGalleryMediaView } from '../../../shared/contracts';
import { formatMomentHeading } from './gallery-timeline';

interface GalleryViewerProps {
  photos: ManagerGalleryMediaView[];
  index: number;
  timeZone: string;
  favoritePendingIds: ReadonlySet<string>;
  onIndexChange(index: number): void;
  onClose(): void;
  onFavorite(photo: ManagerGalleryMediaView): void;
}

export function GalleryViewer({
  photos,
  index,
  timeZone,
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
    aria-label={photo.originalFilename}
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
        ? <img src={mediaPreview(photo.id)} alt={photo.caption ?? photo.originalFilename} />
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
        <strong>{photo.caption ?? photo.originalFilename}</strong>
        <span>From {photo.guestName}</span>
        <span className="gallery-viewer__timing">
          {photo.timelineSource === 'capture' ? 'Taken' : 'Received'} {formatMomentHeading(moment, timeZone)}
        </span>
      </div>
      <button
        type="button"
        className="gallery-viewer__favorite"
        aria-pressed={photo.isFavorite}
        aria-label={`Favorite ${photo.originalFilename}`}
        disabled={favoritePendingIds.has(photo.id)}
        onClick={() => onFavorite(photo)}
      >
        <Heart aria-hidden="true" /> Favorite
      </button>
    </div>
  </div>;
}

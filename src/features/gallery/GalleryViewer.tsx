import { Check, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  // Keyed by photo rather than a boolean, so stepping to the next photo clears
  // the failure without a reset effect and stepping back re-shows it.
  const [failedPreviewId, setFailedPreviewId] = useState<string | null>(null);
  const [host] = useState(() => document.createElement('div'));

  /**
   * The same containment Cover Studio uses. `aria-modal` alone left the manager
   * shell tabbable and readable behind the dialog; inerting the other body
   * children is what actually removes it. This runs as a layout effect so the
   * host is in the document before the focus effect below reaches for the close
   * button. Focus restoration stays with the gallery, which knows the origin tile.
   */
  useLayoutEffect(() => {
    document.body.append(host);
    const inerted: HTMLElement[] = [];
    for (const sibling of Array.from(document.body.children)) {
      if (sibling === host || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute('inert')) continue;
      sibling.setAttribute('inert', '');
      inerted.push(sibling);
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      for (const sibling of inerted) sibling.removeAttribute('inert');
      document.body.style.overflow = previousOverflow;
      host.remove();
    };
  }, [host]);

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
        // Disabled controls must be excluded: Previous is disabled on the first
        // photo and Favorite while its write is in flight, and wrapping onto one
        // of those called focus() on an element that cannot take it, stranding
        // the host where they were.
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
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
  return createPortal(<div
    className="gallery-viewer"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    ref={dialogRef}
  >
    {/* One region, mounted outside every branch below. Stepping through the gallery changes
        only the photograph, so a region rendered beside its own first text is never announced
        and the host navigates in silence. It carries position, title and contributor together
        because those are the three things that tell them where they are. */}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {`${positionLabel(index, photos.length, hasMore)}. ${title}, from ${photo.guestName}.`}
    </p>
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
      {photo.previewAvailable && failedPreviewId !== photo.id
        ? <img
            src={mediaPreview(photo.id)}
            alt={title}
            decoding="async"
            onError={() => setFailedPreviewId(photo.id)}
          />
        : <div className="gallery-viewer__placeholder">
            <strong>{photo.originalFilename}</strong>
            <span>Preview unavailable</span>
            {/* The photograph itself is safe: `stored` already means privately
                delivered, and export eligibility never depends on a preview. Say
                so here, where there is room, rather than leaving a host to guess. */}
            <span>This photo was delivered and is included in your download.</span>
          </div>}
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
        disabled={favoritePendingIds.has(photo.id)}
        onClick={() => onFavorite(photo)}
      >
        {photo.isFavorite
          ? <><Check aria-hidden="true" /> In the album</>
          : <><Plus aria-hidden="true" /> Add to album</>}
      </button>
    </div>
  </div>, host);
}

import { Check, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { mediaPreview } from '../../app/api';
import type { ManagerGalleryMediaView } from '../../../shared/contracts';
import { ModalSurface } from '../../components/ModalSurface';
import { formatMomentHeading, galleryPhotoTitle } from './gallery-timeline';

export type ViewerContinuationOutcome =
  | { status: 'advanced'; nextPhotoId: string }
  | { status: 'exhausted' }
  | { status: 'failed' };

interface GalleryViewerProps {
  photos: ManagerGalleryMediaView[];
  photoId: string;
  timeZone: string;
  /** Whether the timeline still has unloaded pages behind the loaded result set. */
  hasMore: boolean;
  favoritePendingIds: ReadonlySet<string>;
  onPhotoChange(photoId: string): void;
  loadNextAfter(photoId: string): Promise<ViewerContinuationOutcome>;
  onClose(): void;
  onFavorite(photo: ManagerGalleryMediaView): void;
  live?: boolean;
  onAnnouncement?(message: string): void;
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
  photoId,
  timeZone,
  hasMore,
  favoritePendingIds,
  onPhotoChange,
  loadNextAfter,
  onClose,
  onFavorite,
  live = true,
  onAnnouncement,
}: GalleryViewerProps) {
  const index = photos.findIndex((candidate) => candidate.id === photoId);
  const photo = photos[index];
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const inertExceptionRef = useRef<HTMLElement | null>(
    document.querySelector('[data-gallery-live-host="true"]'),
  );
  const retryRef = useRef<HTMLButtonElement>(null);
  const continuationRef = useRef<Promise<ViewerContinuationOutcome> | null>(null);
  const viewerMounted = useRef(true);
  const viewerRequestGeneration = useRef(0);
  const currentPhotoId = useRef(photoId);
  currentPhotoId.current = photoId;
  // Keyed by photo rather than a boolean, so stepping to the next photo clears
  // the failure without a reset effect and stepping back re-shows it.
  const [failedPreviewId, setFailedPreviewId] = useState<string | null>(null);
  const [continuationFailure, setContinuationFailure] = useState(false);
  const [exhaustedContinuationForPhotoId, setExhaustedContinuationForPhotoId] = useState<string | null>(null);
  const liveMessage = photo
    ? `${positionLabel(index, photos.length, hasMore)}. ${galleryPhotoTitle(photo)}, from ${photo.guestName}.`
    : '';

  useEffect(() => {
    if (!live && liveMessage) onAnnouncement?.(liveMessage);
  }, [live, liveMessage, onAnnouncement]);

  useEffect(() => {
    viewerMounted.current = true;
    return () => {
      viewerMounted.current = false;
      viewerRequestGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    if (continuationFailure) retryRef.current?.focus();
  }, [continuationFailure]);

  function changePhoto(nextPhotoId: string) {
    if (nextPhotoId === photoId) return;
    viewerRequestGeneration.current += 1;
    setContinuationFailure(false);
    onPhotoChange(nextPhotoId);
  }

  function closeViewer() {
    viewerRequestGeneration.current += 1;
    onClose();
  }

  function continueForward() {
    if (continuationRef.current) return;
    const retrying = continuationFailure;
    setExhaustedContinuationForPhotoId(null);
    const requestedPhotoId = photoId;
    const request = loadNextAfter(requestedPhotoId);
    continuationRef.current = request;
    const generation = viewerRequestGeneration.current;
    void request.then((outcome) => {
      if (
        !viewerMounted.current
        || generation !== viewerRequestGeneration.current
        || currentPhotoId.current !== requestedPhotoId
      ) return;
      if (outcome.status === 'advanced') {
        if (retrying) {
          closeRef.current?.focus();
          setContinuationFailure(false);
        }
        onPhotoChange(outcome.nextPhotoId);
      }
      if (outcome.status === 'exhausted') {
        if (retrying) {
          closeRef.current?.focus();
          setContinuationFailure(false);
        }
        setExhaustedContinuationForPhotoId(requestedPhotoId);
      }
      if (outcome.status === 'failed') {
        setContinuationFailure(true);
        if (retrying) retryRef.current?.focus();
      }
    }).finally(() => {
      if (continuationRef.current === request) continuationRef.current = null;
    });
  }

  function moveForward() {
    if (index < photos.length - 1) {
      const nextPhoto = photos[index + 1];
      if (nextPhoto) changePhoto(nextPhoto.id);
      return;
    }
    if (hasMore && exhaustedContinuationForPhotoId !== photoId) continueForward();
  }

  function moveBackward() {
    const previousPhoto = photos[index - 1];
    if (previousPhoto) changePhoto(previousPhoto.id);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveForward();
        return;
      }
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault();
        moveBackward();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [index, photos, moveForward, moveBackward]);

  if (!photo) return null;
  const title = galleryPhotoTitle(photo);
  const titleId = `gallery-viewer-title-${photo.id}`;
  const canContinue = index >= photos.length - 1
    && hasMore
    && exhaustedContinuationForPhotoId !== photoId;
  const moment = {
    key: photo.id,
    photos: [photo],
    startAt: photo.timelineAt,
    endAt: photo.timelineAt,
  };
  return <ModalSurface
    labelledBy={titleId}
    initialFocusRef={closeRef}
    onRequestClose={closeViewer}
    closePolicy={{ escape: true, backdrop: true }}
    dialogRef={dialogRef}
    inertExceptionRef={inertExceptionRef}
    returnFocusRef={returnFocusRef}
  ><div className="gallery-viewer">
    {/* One region, mounted outside every branch below. Stepping through the gallery changes
        only the photograph, so a region rendered beside its own first text is never announced
        and the host navigates in silence. It carries position, title and contributor together
        because those are the three things that tell them where they are. */}
    <p
      className="sr-only"
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      aria-atomic={live ? 'true' : undefined}
    >
      {liveMessage}
    </p>
    <button type="button" className="gallery-viewer__close" ref={closeRef} aria-label="Close viewer" onClick={closeViewer}>
      <X aria-hidden="true" />
    </button>
    <button
      type="button"
      className="gallery-viewer__prev"
      disabled={index === 0}
      aria-label="Previous photo"
      onClick={moveBackward}
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
      disabled={index >= photos.length - 1 && !canContinue}
      aria-label={canContinue ? 'Load next photo' : 'Next photo'}
      onClick={moveForward}
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
      {continuationFailure && <div className="gallery-viewer__continuation-failure" role="alert">
        <span>Could not load the next photo. Try again.</span>
        <button
          type="button"
          className="gallery-viewer__continuation-retry"
          ref={retryRef}
          onClick={continueForward}
        >Try again</button>
      </div>}
      <button
        type="button"
        className="gallery-viewer__favorite"
        aria-pressed={photo.isFavorite}
        aria-label={photo.isFavorite
          ? `Remove ${title} from Album`
          : `Pick ${title} for the Album`}
        disabled={favoritePendingIds.has(photo.id)}
        onClick={() => onFavorite(photo)}
      >
        {photo.isFavorite
          ? <><Check aria-hidden="true" /> <span aria-hidden="true">In Album</span></>
          : <><Plus aria-hidden="true" /> <span aria-hidden="true">Pick</span></>}
      </button>
    </div>
  </div></ModalSurface>;
}

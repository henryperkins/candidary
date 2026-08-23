import { Eye, EyeOff, Image as ImageIcon, ImageOff } from 'lucide-react';
import { useState, type Dispatch, type SetStateAction } from 'react';

import { mediaPreview } from '../../app/api';
import type { MediaView } from '../../app/types';
import { MANAGER_BULK_SELECTION_MAX } from '../../../shared/constants';
import type { EventView, PublicationStatus } from '../../../shared/contracts';
import { galleryPhotoTitle } from './gallery-timeline';

export type GallerySharedStatus = 'all' | PublicationStatus;

const SHARED_STATUS_LABELS: Record<PublicationStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  hidden: 'Hidden',
};

/**
 * Keyed by the status union so a new publication status cannot silently inherit the unpublished
 * copy — the empty state is the only thing on screen when it is wrong.
 */
const SHARED_EMPTY_COPY: Record<GallerySharedStatus, { title: string; body: string }> = {
  all: {
    title: 'No photos.',
    body: 'New private deliveries appear here.',
  },
  unpublished: {
    title: 'No unpublished photos.',
    body: 'New private deliveries appear here.',
  },
  published: {
    title: 'No published photos.',
    body: 'Publish a photo to share a preview with guests.',
  },
  hidden: {
    title: 'No hidden photos.',
    body: 'Photos you hide from guests will appear here.',
  },
};

interface ManagerSharedGalleryProps {
  event: EventView;
  media: MediaView[];
  status: GallerySharedStatus;
  selected: string[];
  selectionAtLimit: boolean;
  onStatusChange(status: GallerySharedStatus): void;
  onSelectedChange: Dispatch<SetStateAction<string[]>>;
  onBulk(action: 'publish' | 'hide'): Promise<void>;
  onChangePublication(item: MediaView, action: 'publish' | 'hide'): Promise<void>;
  onOpenSettings(): void;
  /** True while a guest-list commit holds every destination, matching the Manager's own guard. */
  settingsBlocked: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore(): Promise<void>;
  onAnnouncement?(message: string): void;
}

function SharedPhotoPreview({ item, title }: { item: MediaView; title: string }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <div className="gallery-shared__preview-fallback">
        <ImageOff aria-hidden="true" />
        <span>Preview unavailable</span>
      </div>
    : <img
        src={mediaPreview(item.id)}
        alt={title}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />;
}

/**
 * The existing publication workspace extracted from the Manager shell: the
 * unpublished / published / hidden filters and batch publish or hide. Gallery
 * does not become a deletion surface, so the Live Intake delete and individual
 * original download controls are deliberately absent.
 */
export function ManagerSharedGallery({
  event,
  media,
  status,
  selected,
  selectionAtLimit,
  onStatusChange,
  onSelectedChange,
  onBulk,
  onChangePublication,
  onOpenSettings,
  settingsBlocked,
  loadingMore,
  hasMore,
  onLoadMore,
  onAnnouncement,
}: ManagerSharedGalleryProps) {
  const empty = SHARED_EMPTY_COPY[status];
  const [activeBulk, setActiveBulk] = useState<'publish' | 'hide' | null>(null);

  function changeStatus(next: GallerySharedStatus) {
    if (next === status) return;
    onSelectedChange([]);
    onStatusChange(next);
  }

  async function runBulk(action: 'publish' | 'hide') {
    if (activeBulk !== null || selected.length === 0) return;
    const count = selected.length;
    const progressive = action === 'publish' ? 'Publishing' : 'Hiding';
    setActiveBulk(action);
    onAnnouncement?.(`${progressive} ${count} selected photo${count === 1 ? '' : 's'}…`);
    try {
      await onBulk(action);
      onAnnouncement?.(`${progressive} finished.`);
    } catch {
      onAnnouncement?.(`${progressive} could not be completed.`);
    } finally {
      setActiveBulk(null);
    }
  }

  return <div className="gallery-shared">
    <p className="gallery-shared__lede">
      Publication is a separate axis from the album. A photo is delivered privately whether or not it is published, and an album pick never publishes anything.
    </p>
    <div className="filter-tabs" role="group" aria-label="Publication status">
      {(['unpublished', 'published', 'hidden'] as const).map((value) => (
        <button
          type="button"
          className={status === value ? 'active' : ''}
          aria-pressed={status === value}
          key={value}
          onClick={() => changeStatus(value)}
        >{SHARED_STATUS_LABELS[value]}</button>
      ))}
    </div>
    {!event.galleryVisible && <div className="manager-notice">
      <span>The optional shared gallery is off. Publishing choices are saved until you turn it on.</span>
      <button
        type="button"
        className="text-button"
        disabled={settingsBlocked}
        onClick={onOpenSettings}
      >Open settings</button>
    </div>}
    <div className="bulk-bar" aria-busy={activeBulk !== null}>
      <span
        id="bulk-selection-status"
      >
        {selectionAtLimit
          ? `${MANAGER_BULK_SELECTION_MAX} of ${MANAGER_BULK_SELECTION_MAX} photos selected. Remove one to choose another.`
          : selected.length
            ? `${selected.length} selected`
            : 'Select photos to update the optional gallery'}
      </span>
      <button
        type="button"
        className="button button--approve"
        disabled={!selected.length || activeBulk !== null}
        aria-busy={activeBulk === 'publish' || undefined}
        onClick={() => void runBulk('publish')}
      ><Eye aria-hidden="true" /> {activeBulk === 'publish' ? 'Publishing…' : 'Publish selected'}</button>
      <button
        type="button"
        className="button button--danger-outline"
        disabled={!selected.length || activeBulk !== null}
        aria-busy={activeBulk === 'hide' || undefined}
        onClick={() => void runBulk('hide')}
      ><EyeOff aria-hidden="true" /> {activeBulk === 'hide' ? 'Hiding…' : 'Hide selected'}</button>
    </div>
    {media.length === 0
      ? <div className="empty-state"><ImageIcon aria-hidden="true" /><h3>{empty.title}</h3><p>{empty.body}</p></div>
      : <>
          <div className="moderation-grid intake-grid">
            {media.map((item) => {
              const isSelected = selected.includes(item.id);
              const selectionUnavailable = !isSelected && selectionAtLimit;
              // The card names the photo the way the private timeline does. Its controls keep naming
              // the file, because Live Intake's identical cards act on files — download, delete — and
              // the two grids must not disagree about what a control is pointed at.
              const title = galleryPhotoTitle(item);
              return <article className={isSelected ? 'selected' : ''} key={item.id}>
                <div className="intake-photo">
                  <label className="intake-select"><input
                    type="checkbox"
                    aria-label={`Select ${title}`}
                    aria-describedby={selectionUnavailable ? 'bulk-selection-status' : undefined}
                    checked={isSelected}
                    disabled={selectionUnavailable}
                    onChange={(change) => onSelectedChange((current) => {
                      if (!change.target.checked) return current.filter((id) => id !== item.id);
                      if (current.includes(item.id) || current.length >= MANAGER_BULK_SELECTION_MAX) return current;
                      return [...current, item.id];
                    })}
                  /></label>
                  <SharedPhotoPreview item={item} title={title} />
                </div>
                <div>
                  <span className={`publication publication--${item.publicationStatus}`}>{item.publicationStatus}</span>
                  <strong title={title}>{title}</strong>
                  <small>From {item.guestName}</small>
                  <div className="intake-card-actions">
                    {item.publicationStatus !== 'published' && (
                      <button
                        type="button"
                        aria-label={`Publish ${item.originalFilename}`}
                        onClick={() => void onChangePublication(item, 'publish')}
                      ><Eye aria-hidden="true" /> Publish</button>
                    )}
                    {item.publicationStatus !== 'hidden' && (
                      <button
                        type="button"
                        className="gallery-shared__hide"
                        aria-label={`Hide ${item.originalFilename}`}
                        onClick={() => void onChangePublication(item, 'hide')}
                      ><EyeOff aria-hidden="true" /> Hide</button>
                    )}
                  </div>
                </div>
              </article>;
            })}
          </div>
          {hasMore && <div className="media-more">
            <button
              type="button"
              className="button button--secondary"
              disabled={loadingMore}
              onClick={() => void onLoadMore()}
            >{loadingMore ? 'Loading more photos…' : 'Load more photos'}</button>
          </div>}
        </>}
  </div>;
}

import { Eye, EyeOff, Image as ImageIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

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
  live?: boolean;
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
  live = true,
}: ManagerSharedGalleryProps) {
  const empty = SHARED_EMPTY_COPY[status];
  return <div className="gallery-shared">
    <div className="filter-tabs" role="group" aria-label="Publication status">
      {(['unpublished', 'published', 'hidden'] as const).map((value) => (
        <button
          type="button"
          className={status === value ? 'active' : ''}
          aria-pressed={status === value}
          key={value}
          onClick={() => onStatusChange(value)}
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
    <div className="bulk-bar">
      <span
        id="bulk-selection-status"
        role={live ? 'status' : undefined}
        aria-live={live ? 'polite' : undefined}
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
        disabled={!selected.length}
        onClick={() => void onBulk('publish')}
      ><Eye aria-hidden="true" /> Publish selected</button>
      <button
        type="button"
        className="button button--danger-outline"
        disabled={!selected.length}
        onClick={() => void onBulk('hide')}
      ><EyeOff aria-hidden="true" /> Hide selected</button>
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
                    aria-label={`Select ${item.originalFilename}`}
                    aria-describedby={selectionUnavailable ? 'bulk-selection-status' : undefined}
                    checked={isSelected}
                    disabled={selectionUnavailable}
                    onChange={(change) => onSelectedChange((current) => {
                      if (!change.target.checked) return current.filter((id) => id !== item.id);
                      if (current.includes(item.id) || current.length >= MANAGER_BULK_SELECTION_MAX) return current;
                      return [...current, item.id];
                    })}
                  /></label>
                  <img src={mediaPreview(item.id)} alt={title} loading="lazy" decoding="async" />
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

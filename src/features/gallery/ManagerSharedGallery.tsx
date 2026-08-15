import { Eye, EyeOff, Image as ImageIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

import { mediaPreview } from '../../app/api';
import type { MediaView } from '../../app/types';
import { MANAGER_BULK_SELECTION_MAX } from '../../../shared/constants';
import type { EventView, PublicationStatus } from '../../../shared/contracts';

export type GallerySharedStatus = 'all' | PublicationStatus;

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
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore(): Promise<void>;
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
  loadingMore,
  hasMore,
  onLoadMore,
}: ManagerSharedGalleryProps) {
  return <div className="gallery-shared">
    <div className="filter-tabs" role="group" aria-label="Publication status">
      {(['unpublished', 'published', 'hidden'] as const).map((value) => (
        <button
          type="button"
          className={status === value ? 'active' : ''}
          key={value}
          onClick={() => onStatusChange(value)}
        >{value}</button>
      ))}
    </div>
    {!event.galleryVisible && <p className="manager-notice">The guest gallery is off. Publishing choices are saved for whenever you enable it.</p>}
    <div className="bulk-bar">
      <span id="bulk-selection-status" role="status" aria-live="polite">
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
      ? <div className="empty-state"><ImageIcon aria-hidden="true" /><h3>No matching photos.</h3><p>New private deliveries will appear here immediately.</p></div>
      : <>
          <div className="moderation-grid intake-grid">
            {media.map((item) => {
              const isSelected = selected.includes(item.id);
              const selectionUnavailable = !isSelected && selectionAtLimit;
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
                  <img src={mediaPreview(item.id)} alt={item.caption || item.originalFilename} loading="lazy" decoding="async" />
                </div>
                <div>
                  <span className={`publication publication--${item.publicationStatus}`}>{item.publicationStatus}</span>
                  <strong title={item.caption || item.originalFilename}>{item.caption || item.originalFilename}</strong>
                  <small>From {item.guestName}</small>
                  <div className="intake-card-actions">
                    {item.publicationStatus !== 'published' && <button type="button" aria-label={`Publish ${item.originalFilename}`} onClick={() => void onChangePublication(item, 'publish')}><Eye aria-hidden="true" /></button>}
                    {item.publicationStatus !== 'hidden' && <button type="button" aria-label={`Hide ${item.originalFilename}`} onClick={() => void onChangePublication(item, 'hide')}><EyeOff aria-hidden="true" /></button>}
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
            >Load more photos</button>
          </div>}
        </>}
  </div>;
}

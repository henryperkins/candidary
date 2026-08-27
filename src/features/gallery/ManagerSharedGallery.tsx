import { Eye, EyeOff, Image as ImageIcon, ImageOff } from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { mediaPreview } from '../../app/api';
import type { MediaView } from '../../app/types';
import type { PublicationStatus } from '../../../shared/contracts';
import { galleryPhotoTitle } from './gallery-timeline';
import {
  selectionCapacityMessage,
  selectionCountMessage,
  transitionSelection,
  type GallerySelectionAction,
} from './selection-state';
import type { GalleryAnchor, PublicationFilter } from '../../app/manager-history-state';
import { captureRenderedGalleryAnchor, restoreRenderedGalleryAnchor } from './gallery-anchor';

export type GallerySharedStatus = PublicationFilter;

export const PUBLICATION_LABELS: Record<PublicationStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  hidden: 'Hidden',
};

const PUBLICATION_FILTER_LABELS: Record<GallerySharedStatus, string> = {
  all: 'All',
  ...PUBLICATION_LABELS,
};

/**
 * Keyed by the status union so a new publication status cannot silently inherit the unpublished
 * copy — the empty state is the only thing on screen when it is wrong.
 */
const SHARED_EMPTY_COPY: Record<GallerySharedStatus, { title: string; body: string }> = {
  all: {
    title: 'No photos.',
    body: 'New delivered photos appear here.',
  },
  unpublished: {
    title: 'No unpublished photos.',
    body: 'New delivered photos appear here.',
  },
  published: {
    title: 'No published photos.',
    body: 'Publish a photo to show it in the Guest gallery.',
  },
  hidden: {
    title: 'No hidden photos.',
    body: 'Photos Hidden from event guests appear here.',
  },
};

interface ManagerSharedGalleryProps {
  guestGalleryVisible: boolean;
  media: MediaView[];
  status: GallerySharedStatus;
  selected: string[];
  selectionAtLimit: boolean;
  onStatusChange(status: GallerySharedStatus): void;
  onSelectedChange: Dispatch<SetStateAction<string[]>>;
  onBulk(action: 'publish' | 'hide'): Promise<void>;
  onChangePublication(item: MediaView, action: 'publish' | 'hide'): Promise<void>;
  onOpenSettings(status: PublicationFilter): void;
  /** True while a guest-list commit holds every destination, matching the Manager's own guard. */
  settingsBlocked: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore(): Promise<void>;
  onAnnouncement?(message: string): void;
}

export interface ManagerSharedGalleryHandle {
  captureAnchor(effectiveVisibleTop: number): GalleryAnchor | null;
  restoreAnchor(anchor: GalleryAnchor, effectiveVisibleTop: number): 'item' | 'fallback';
  focusSettingsAction(): void;
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
 * does not become a deletion surface, so the Live intake delete and individual
 * original download controls are deliberately absent.
 */
export const ManagerSharedGallery = forwardRef<ManagerSharedGalleryHandle, ManagerSharedGalleryProps>(function ManagerSharedGallery({
  guestGalleryVisible,
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
}, ref) {
  const empty = SHARED_EMPTY_COPY[status];
  const [activeBulk, setActiveBulk] = useState<'publish' | 'hide' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const settingsActionRef = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    captureAnchor: (effectiveVisibleTop) => rootRef.current
      ? captureRenderedGalleryAnchor(rootRef.current, 'media', effectiveVisibleTop)
      : null,
    restoreAnchor: (anchor, effectiveVisibleTop) => restoreRenderedGalleryAnchor(
      rootRef.current ?? document.createElement('div'),
      anchor,
      effectiveVisibleTop,
    ),
    focusSettingsAction: () => settingsActionRef.current?.focus(),
  }), []);

  function changeStatus(next: GallerySharedStatus) {
    if (next === status) return;
    commitSelection({ type: 'clear' });
    onStatusChange(next);
  }

  function commitSelection(action: GallerySelectionAction) {
    const transition = transitionSelection(new Set(selected), action);
    onSelectedChange([...transition.next]);
    if (transition.message !== null) onAnnouncement?.(transition.message);
  }

  function openSettings() {
    commitSelection({ type: 'clear' });
    onOpenSettings(status);
  }

  async function runBulk(action: 'publish' | 'hide') {
    if (activeBulk !== null || selected.length === 0) return;
    const count = selected.length;
    const progressive = action === 'publish' ? 'Publishing' : 'Hiding';
    setActiveBulk(action);
    onAnnouncement?.(`${progressive} ${count} selected photo${count === 1 ? '' : 's'}…`);
    try {
      await onBulk(action);
    } catch {
      // The workspace sees confirmed groups and owns the one complete terminal outcome.
    } finally {
      setActiveBulk(null);
    }
  }

  return <div className="gallery-shared" ref={rootRef}>
    <p className="gallery-shared__lede">
      {guestGalleryVisible
        ? 'Published photos are visible to event guests.'
        : 'Publication choices are saved, but the Guest gallery is off.'}
    </p>
    <div className="filter-tabs" role="group" aria-label="Publication status">
      {(['all', 'unpublished', 'published', 'hidden'] as const).map((value) => (
        <button
          type="button"
          className={status === value ? 'active' : ''}
          aria-pressed={status === value}
          key={value}
          onClick={() => changeStatus(value)}
        >{PUBLICATION_FILTER_LABELS[value]}</button>
      ))}
    </div>
    {!guestGalleryVisible && <div className="manager-notice">
      <button
        type="button"
        className="text-button"
        ref={settingsActionRef}
        disabled={settingsBlocked}
        onClick={openSettings}
      >Open settings</button>
    </div>}
    <div className="bulk-bar" aria-busy={activeBulk !== null}>
      <span
        id="bulk-selection-status"
      >
        {selectionAtLimit
          ? selectionCapacityMessage()
          : selectionCountMessage(selected.length)}
      </span>
      <button
        type="button"
        className={`button ${status === 'published' ? 'button--secondary' : 'button--approve'}`}
        disabled={!selected.length || activeBulk !== null}
        aria-busy={activeBulk === 'publish' || undefined}
        onClick={() => void runBulk('publish')}
      ><Eye aria-hidden="true" /> {activeBulk === 'publish' ? 'Publishing…' : 'Publish selected'}</button>
      <button
        type="button"
        className={`button ${status === 'published' ? 'button--primary' : 'button--secondary'}`}
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
              // the file, because Live intake's identical cards act on files — download, delete — and
              // the two grids must not disagree about what a control is pointed at.
              const title = galleryPhotoTitle(item);
              return <article
                className={isSelected ? 'selected' : ''}
                data-gallery-anchor-id={item.id}
                key={item.id}
              >
                <div className="intake-photo">
                  <label className="intake-select"><input
                    type="checkbox"
                    aria-label={`Select ${title}`}
                    aria-describedby={selectionUnavailable ? 'bulk-selection-status' : undefined}
                    checked={isSelected}
                    disabled={selectionUnavailable}
                    onChange={() => commitSelection({ type: 'toggle', id: item.id, label: title })}
                  /></label>
                  <SharedPhotoPreview item={item} title={title} />
                </div>
                <div>
                  <span className={`publication publication--${item.publicationStatus}`}>
                    {PUBLICATION_LABELS[item.publicationStatus]}
                  </span>
                  <strong title={title}>{title}</strong>
                  <small>From {item.guestName}</small>
                  <div className="intake-card-actions">
                    {item.publicationStatus !== 'published' && (
                      <button
                        type="button"
                        className="button button--approve"
                        aria-label={`Publish ${item.originalFilename}`}
                        onClick={() => void onChangePublication(item, 'publish')}
                      ><Eye aria-hidden="true" /> Publish</button>
                    )}
                    {item.publicationStatus !== 'hidden' && (
                      <button
                        type="button"
                        className={`button ${item.publicationStatus === 'published' ? 'button--primary' : 'button--secondary'} gallery-shared__hide`}
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
});

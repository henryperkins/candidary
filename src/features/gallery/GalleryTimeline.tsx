import { useMemo } from 'react';

import type { ManagerGalleryMediaView } from '../../../shared/contracts';
import { GalleryMoment } from './GalleryMoment';
import { buildMoments } from './gallery-timeline';

interface GalleryTimelineProps {
  wall?: boolean;
  photos: ManagerGalleryMediaView[];
  timeZone: string;
  hasMore: boolean;
  loadingMore: boolean;
  favoritePendingIds: ReadonlySet<string>;
  mutationLocked?: boolean;
  selecting: boolean;
  selectedIds: ReadonlySet<string>;
  onLoadMore(): void;
  onOpen(photo: ManagerGalleryMediaView, origin: HTMLElement): void;
  onFavorite(photo: ManagerGalleryMediaView, origin?: HTMLElement, input?: 'keyboard' | 'pointer'): void;
  onToggleSelected(photo: ManagerGalleryMediaView): void;
  onSelectMoment(photos: readonly ManagerGalleryMediaView[]): void;
}

export function GalleryTimeline({
  wall = false,
  photos,
  timeZone,
  hasMore,
  loadingMore,
  favoritePendingIds,
  mutationLocked,
  selecting,
  selectedIds,
  onLoadMore,
  onOpen,
  onFavorite,
  onToggleSelected,
  onSelectMoment,
}: GalleryTimelineProps) {
  const moments = useMemo(() => buildMoments(photos), [photos]);
  return <div className={`gallery-timeline${wall ? ' gallery-photo-wall' : ''}`} data-selecting={selecting || undefined}>
    {moments.map((moment, index) => (
      <GalleryMoment
        wall={wall}
        key={moment.key}
        moment={moment}
        timeZone={timeZone}
        eager={index === 0}
        favoritePendingIds={favoritePendingIds}
        mutationLocked={mutationLocked}
        selecting={selecting}
        selectedIds={selectedIds}
        onOpen={onOpen}
        onFavorite={onFavorite}
        onToggleSelected={onToggleSelected}
        onSelectMoment={onSelectMoment}
      />
    ))}
    {hasMore && <div className="media-more">
      <button
        type="button"
        className="button button--secondary"
        disabled={loadingMore}
        onClick={onLoadMore}
      >{loadingMore ? 'Loading more photos…' : 'Load more photos'}</button>
    </div>}
  </div>;
}

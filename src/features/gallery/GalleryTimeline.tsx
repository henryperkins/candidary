import { useMemo } from 'react';

import type { ManagerGalleryMediaView } from '../../../shared/contracts';
import { GalleryMoment } from './GalleryMoment';
import { buildMoments } from './gallery-timeline';

interface GalleryTimelineProps {
  photos: ManagerGalleryMediaView[];
  timeZone: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  onOpen(photo: ManagerGalleryMediaView, origin: HTMLElement): void;
  onFavorite(photo: ManagerGalleryMediaView): void;
}

export function GalleryTimeline({
  photos,
  timeZone,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
  onFavorite,
}: GalleryTimelineProps) {
  const moments = useMemo(() => buildMoments(photos), [photos]);
  return <div className="gallery-timeline">
    {moments.map((moment) => (
      <GalleryMoment
        key={moment.key}
        moment={moment}
        timeZone={timeZone}
        onOpen={onOpen}
        onFavorite={onFavorite}
      />
    ))}
    {hasMore && <div className="media-more">
      <button
        type="button"
        className="button button--secondary"
        disabled={loadingMore}
        onClick={onLoadMore}
      >Load more photos</button>
    </div>}
  </div>;
}

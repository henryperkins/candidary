import { Heart, ImageOff } from 'lucide-react';
import { useState, type CSSProperties } from 'react';

import { mediaPreview } from '../../app/api';
import type { ManagerGalleryMediaView } from '../../../shared/contracts';
import { formatMomentHeading, galleryPhotoTitle, mosaicStyleVars, type GalleryMoment as MomentModel } from './gallery-timeline';

export const COMPACT_MOSAIC_LIMIT = 8;

interface GalleryMomentProps {
  moment: MomentModel;
  timeZone: string;
  eager: boolean;
  favoritePendingIds: ReadonlySet<string>;
  onOpen(photo: ManagerGalleryMediaView, origin: HTMLElement): void;
  onFavorite(photo: ManagerGalleryMediaView): void;
}

export function GalleryMoment({
  moment,
  timeZone,
  eager,
  favoritePendingIds,
  onOpen,
  onFavorite,
}: GalleryMomentProps) {
  const [expanded, setExpanded] = useState(false);
  const photos = expanded ? moment.photos : moment.photos.slice(0, COMPACT_MOSAIC_LIMIT);

  return <section className="gallery-moment" aria-labelledby={`moment-heading-${moment.key}`}>
    <header className="gallery-moment__heading">
      <h3 id={`moment-heading-${moment.key}`} tabIndex={-1}>{formatMomentHeading(moment, timeZone)}</h3>
      <span className="gallery-moment__count">
        {moment.photos.length} photo{moment.photos.length === 1 ? '' : 's'}
      </span>
    </header>
    <div className="gallery-mosaic" id={`moment-photos-${moment.key}`}>
      {photos.map((photo, index) => {
        const title = galleryPhotoTitle(photo);
        return <div
          className="gallery-mosaic__item"
          key={photo.id}
          data-photo-id={photo.id}
          style={mosaicStyleVars(index + 1) as CSSProperties}
        >
          {photo.previewAvailable
            ? <img
                src={mediaPreview(photo.id)}
                alt={title}
                loading={eager && index < 4 ? 'eager' : 'lazy'}
                fetchPriority={eager && index === 0 ? 'high' : undefined}
                decoding="async"
              />
            : <div className="gallery-mosaic__placeholder" aria-hidden="true"><ImageOff aria-hidden="true" /></div>}
          <button
            type="button"
            className="gallery-mosaic__open"
            aria-label={`Open ${title}`}
            onClick={(event) => onOpen(photo, event.currentTarget)}
          />
          <button
            type="button"
            className="gallery-mosaic__favorite"
            aria-pressed={photo.isFavorite}
            aria-label={`Favorite ${title}`}
            disabled={favoritePendingIds.has(photo.id)}
            onClick={() => onFavorite(photo)}
          >
            <Heart aria-hidden="true" fill={photo.isFavorite ? 'currentColor' : 'none'} />
          </button>
          <div className="gallery-mosaic__meta">
            <strong title={title}>{title}</strong>
            <small>From {photo.guestName}</small>
          </div>
        </div>;
      })}
    </div>
    {/* Spec 6.4 accepts the moment heading or the expansion control. The control is the one that
        survives the collapse, so focus stays on it: sending focus back up to the heading would make
        the host tab through every remaining tile again to reach the button they just pressed. */}
    {moment.photos.length > COMPACT_MOSAIC_LIMIT && (
      <button
        type="button"
        className="gallery-moment__toggle"
        aria-expanded={expanded}
        aria-controls={`moment-photos-${moment.key}`}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? 'Show fewer photos' : 'Show more photos'}
      </button>
    )}
  </section>;
}

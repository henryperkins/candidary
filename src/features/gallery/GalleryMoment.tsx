import { Heart, ImageOff } from 'lucide-react';
import { useState, type CSSProperties } from 'react';

import { mediaPreview } from '../../app/api';
import type { ManagerGalleryMediaView } from '../../../shared/contracts';
import { formatMomentHeading, mosaicStyleVars, type GalleryMoment as MomentModel } from './gallery-timeline';

export const COMPACT_MOSAIC_LIMIT = 8;

interface GalleryMomentProps {
  moment: MomentModel;
  timeZone: string;
  onOpen(photo: ManagerGalleryMediaView, origin: HTMLElement): void;
  onFavorite(photo: ManagerGalleryMediaView): void;
}

export function GalleryMoment({ moment, timeZone, onOpen, onFavorite }: GalleryMomentProps) {
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
      {photos.map((photo, index) => (
        <div
          className="gallery-mosaic__item"
          key={photo.id}
          data-photo-id={photo.id}
          style={mosaicStyleVars(index + 1) as CSSProperties}
        >
          {photo.previewAvailable
            ? <img src={mediaPreview(photo.id)} alt={photo.caption ?? photo.originalFilename} loading="lazy" decoding="async" />
            : <div className="gallery-mosaic__placeholder" aria-hidden="true"><ImageOff aria-hidden="true" /></div>}
          <button
            type="button"
            className="gallery-mosaic__open"
            aria-label={`Open ${photo.originalFilename}`}
            onClick={(event) => onOpen(photo, event.currentTarget)}
          />
          <button
            type="button"
            className="gallery-mosaic__favorite"
            aria-pressed={photo.isFavorite}
            aria-label={`Favorite ${photo.originalFilename}`}
            onClick={() => onFavorite(photo)}
          >
            <Heart aria-hidden="true" />
          </button>
          <div className="gallery-mosaic__meta">
            <strong title={photo.caption ?? photo.originalFilename}>{photo.caption ?? photo.originalFilename}</strong>
            <small>From {photo.guestName}</small>
          </div>
        </div>
      ))}
    </div>
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

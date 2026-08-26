import { Check, ImageOff, Plus } from 'lucide-react';
import { useState, type CSSProperties } from 'react';

import { mediaPreview } from '../../app/api';
import type { ManagerGalleryMediaView } from '../../../shared/contracts';
import { formatMomentHeading, galleryPhotoTitle, mosaicStyleVars, type GalleryMoment as MomentModel } from './gallery-timeline';
import { PUBLICATION_LABELS } from './ManagerSharedGallery';

export const COMPACT_MOSAIC_LIMIT = 8;

interface GalleryTileProps {
  photo: ManagerGalleryMediaView;
  position: number;
  eager: boolean;
  favoritePending: boolean;
  selecting: boolean;
  selected: boolean;
  onOpen(photo: ManagerGalleryMediaView, origin: HTMLElement): void;
  onFavorite(photo: ManagerGalleryMediaView): void;
  onToggleSelected(photo: ManagerGalleryMediaView): void;
}

/**
 * One photograph. The tile owns its own failed-load state because a preview can
 * fail per photo — an object still promoting between buckets, or the image
 * service refusing one file — and a single flag on the moment would blank the
 * neighbours too. The unavailable state is deliberately *text*, not a bare icon:
 * a host looking at their wedding needs to be told that the photo is fine and
 * only its preview is missing, which is what the system already guarantees.
 *
 * While a selection is running the covering button selects instead of opening, and the
 * per-tile pick control is gone: the tray owns both verbs then, and two ways to change
 * membership on one tile is how a host ends up adding the photo they meant to select.
 */
function GalleryTile({
  photo,
  position,
  eager,
  favoritePending,
  selecting,
  selected,
  onOpen,
  onFavorite,
  onToggleSelected,
}: GalleryTileProps) {
  const [failed, setFailed] = useState(false);
  const title = galleryPhotoTitle(photo);
  return <div
    className={selected ? 'gallery-mosaic__item is-selected' : 'gallery-mosaic__item'}
    data-photo-id={photo.id}
    style={mosaicStyleVars(position) as CSSProperties}
  >
    {/* The covering button carries this tile's accessible name, so the image, the visible caption,
        and the button previously announced the same string three times over — 48 tiles a page. The
        photograph is decorative here and the caption is its echo; the one button says it once, and
        picks up the contributor the caption would otherwise have been alone in carrying. */}
    {photo.previewAvailable && !failed
      ? <img
          src={mediaPreview(photo.id)}
          alt=""
          // Already on the wire and previously unused. The tile crops to a fixed grid cell,
          // so this is not about reserving space — it hands the decoder the real ratio
          // instead of leaving it to infer one mid-download.
          width={photo.width ?? undefined}
          height={photo.height ?? undefined}
          loading={eager && position <= 4 ? 'eager' : 'lazy'}
          fetchPriority={eager && position === 1 ? 'high' : undefined}
          decoding="async"
          onError={() => setFailed(true)}
        />
      : <div className="gallery-mosaic__placeholder">
          <ImageOff aria-hidden="true" />
          <span>Preview unavailable</span>
        </div>}
    {selecting
      ? <button
          type="button"
          className="gallery-mosaic__open gallery-mosaic__select"
          aria-pressed={selected}
          aria-label={`${selected ? 'Deselect' : 'Select'} ${title}, from ${photo.guestName}`}
          onClick={() => onToggleSelected(photo)}
        >
          <span className="gallery-mosaic__checkbox" aria-hidden="true">
            {selected && <Check />}
          </span>
        </button>
      : <>
          <button
            type="button"
            className="gallery-mosaic__open"
            aria-label={`Open ${title}, from ${photo.guestName}`}
            onClick={(event) => onOpen(photo, event.currentTarget)}
          />
          {/* Plus-then-check, not a heart. The control itself is the one visible Album-membership
              state, so a picked card never repeats the same fact in a second badge. */}
          <button
            type="button"
            className="gallery-mosaic__favorite"
            aria-pressed={photo.isFavorite}
            aria-label={photo.isFavorite
              ? `Remove ${title} from Album`
              : `Pick ${title} for the Album`}
            disabled={favoritePending}
            onClick={() => onFavorite(photo)}
          >
            {photo.isFavorite ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
            <span aria-hidden="true">{photo.isFavorite ? 'In Album' : 'Pick'}</span>
          </button>
        </>}
    <span className={`gallery-mosaic__publication publication--${photo.publicationStatus}`}>
      Guest gallery · {PUBLICATION_LABELS[photo.publicationStatus]}
    </span>
    {/* Only the hero carries a visible caption. On a unit tile the band covered ~59% of the
        photograph to restate a camera filename the open control already announces, and its
        contrast was a function of whatever the photo happened to be underneath. */}
    {position === 1 && <div className="gallery-mosaic__meta" aria-hidden="true">
      <strong title={title}>{title}</strong>
      <small>From {photo.guestName}</small>
    </div>}
  </div>;
}

interface GalleryMomentProps {
  moment: MomentModel;
  timeZone: string;
  eager: boolean;
  favoritePendingIds: ReadonlySet<string>;
  selecting: boolean;
  selectedIds: ReadonlySet<string>;
  onOpen(photo: ManagerGalleryMediaView, origin: HTMLElement): void;
  onFavorite(photo: ManagerGalleryMediaView): void;
  onToggleSelected(photo: ManagerGalleryMediaView): void;
  onSelectMoment(photos: readonly ManagerGalleryMediaView[]): void;
}

export function GalleryMoment({
  moment,
  timeZone,
  eager,
  favoritePendingIds,
  selecting,
  selectedIds,
  onOpen,
  onFavorite,
  onToggleSelected,
  onSelectMoment,
}: GalleryMomentProps) {
  const [expanded, setExpanded] = useState(false);
  const photos = expanded ? moment.photos : moment.photos.slice(0, COMPACT_MOSAIC_LIMIT);
  const wholeMomentSelected = moment.photos.every((photo) => selectedIds.has(photo.id));

  return <section className="gallery-moment" aria-labelledby={`moment-heading-${moment.key}`}>
    <header className="gallery-moment__heading">
      <h3 id={`moment-heading-${moment.key}`} tabIndex={-1}>{formatMomentHeading(moment, timeZone)}</h3>
      <span className="gallery-moment__count">
        {moment.photos.length} photo{moment.photos.length === 1 ? '' : 's'}
      </span>
      {/* Selects the whole moment, not the eight tiles currently drawn: a host who collapsed
          a run of sixty still means the run. */}
      {selecting && <button
        type="button"
        className="gallery-moment__select"
        onClick={() => onSelectMoment(moment.photos)}
      >{wholeMomentSelected ? 'Clear this moment' : 'Select this moment'}</button>}
    </header>
    <div className="gallery-mosaic" id={`moment-photos-${moment.key}`}>
      {photos.map((photo, index) => (
        <GalleryTile
          key={photo.id}
          photo={photo}
          position={index + 1}
          eager={eager}
          favoritePending={favoritePendingIds.has(photo.id)}
          selecting={selecting}
          selected={selectedIds.has(photo.id)}
          onOpen={onOpen}
          onFavorite={onFavorite}
          onToggleSelected={onToggleSelected}
        />
      ))}
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

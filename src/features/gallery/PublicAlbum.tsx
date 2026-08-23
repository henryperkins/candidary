import { ImageOff } from 'lucide-react';
import { useState } from 'react';

import type { PublicAlbumView } from '../../../shared/contracts';
import { publicAlbumPreview } from './album-share-api';

function AlbumImage({ mediaId, alt, className }: {
  mediaId: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <div className={`public-album__preview-fallback ${className ?? ''}`}>
      <ImageOff aria-hidden="true" />
      <span>Preview unavailable</span>
    </div>;
  }
  return <img
    className={className}
    src={publicAlbumPreview(mediaId)}
    alt={alt}
    loading="lazy"
    decoding="async"
    onError={() => setFailed(true)}
  />;
}

export function PublicAlbum({ album }: { album: PublicAlbumView }) {
  let photoPosition = 0;
  return <main className="public-album">
    <header className="public-album__intro">
      {album.coverMediaId && <AlbumImage
        mediaId={album.coverMediaId}
        alt={`Cover for ${album.title}`}
        className="public-album__cover"
      />}
      <div className="public-album__copy">
        <h1>{album.title}</h1>
        {album.description && <p>{album.description}</p>}
        <span>{album.photoCount} {album.photoCount === 1 ? 'photo' : 'photos'}</span>
      </div>
    </header>

    <div className="public-album__entries">
      {album.entries.map((entry) => {
        if (entry.kind === 'section') {
          return <h2 className="public-album__section" key={entry.id}>{entry.heading}</h2>;
        }
        photoPosition += 1;
        const position = photoPosition;
        return <figure className="public-album__photo" key={entry.photo.id}>
          {entry.photo.previewAvailable
            ? <AlbumImage
                mediaId={entry.photo.id}
                alt={entry.photo.caption ?? `Album photo ${position}`}
              />
            : <div className="public-album__preview-fallback">
                <ImageOff aria-hidden="true" />
                <span>Preview unavailable</span>
              </div>}
          {entry.photo.caption && <figcaption>{entry.photo.caption}</figcaption>}
        </figure>;
      })}
    </div>
  </main>;
}

import { ImageOff } from 'lucide-react';
import { useState } from 'react';

import type { PublicAlbumEntryView, PublicAlbumView } from '../../../shared/contracts';
import { publicAlbumPreview } from './album-share-api';

function AlbumPreviewFallback({ label, className }: { label: string; className?: string }) {
  return <div
    className={`public-album__preview-fallback ${className ?? ''}`}
    role="img"
    aria-label={label}
  >
    <ImageOff aria-hidden="true" />
    <span>Preview unavailable</span>
  </div>;
}

function AlbumImage({ mediaId, alt, className }: {
  mediaId: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <AlbumPreviewFallback label={alt} className={className} />;
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

type PublicPhotoEntry = Extract<PublicAlbumEntryView, { kind: 'photo' }>;

interface PublicAlbumBlock {
  key: string;
  heading: string | null;
  photos: Array<{ entry: PublicPhotoEntry; position: number }>;
}

function publicAlbumBlocks(entries: readonly PublicAlbumEntryView[]): PublicAlbumBlock[] {
  const blocks: PublicAlbumBlock[] = [];
  let position = 0;
  for (const entry of entries) {
    if (entry.kind === 'section') {
      blocks.push({ key: `section:${entry.id}`, heading: entry.heading, photos: [] });
      continue;
    }
    if (blocks.length === 0) blocks.push({ key: 'lead', heading: null, photos: [] });
    position += 1;
    blocks.at(-1)!.photos.push({ entry, position });
  }
  return blocks;
}

export function PublicAlbum({ album }: { album: PublicAlbumView }) {
  return <main className="public-album">
    <header className="public-album__intro">
      {album.coverMediaId && <AlbumImage
        key={album.coverMediaId}
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

    <div className="public-album__blocks">
      {publicAlbumBlocks(album.entries).map((block) => <section
        className="public-album__block"
        key={block.key}
      >
        {block.heading && <h2 className="public-album__section">{block.heading}</h2>}
        {block.photos.length > 0 && <div className="public-album__photos">
          {block.photos.map(({ entry, position }) => {
            const label = entry.photo.caption?.trim() || `Album photo ${position}`;
            return <figure className="public-album__photo" key={entry.photo.id}>
              {entry.photo.previewAvailable
                ? <AlbumImage
                    mediaId={entry.photo.id}
                    alt={label}
                  />
                : <AlbumPreviewFallback label={label} />}
              {entry.photo.caption && <figcaption>{entry.photo.caption}</figcaption>}
            </figure>;
          })}
        </div>}
      </section>)}
    </div>
  </main>;
}

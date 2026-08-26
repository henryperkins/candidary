import { ImageOff } from 'lucide-react';
import { useState } from 'react';

import type { PublicAlbumEntryView, PublicAlbumView } from '../../../shared/contracts';

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

function AlbumImage({ src, alt, className }: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <AlbumPreviewFallback label={alt} className={className} />;
  }
  return <img
    className={className}
    src={src}
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
  let pendingSection: Extract<PublicAlbumEntryView, { kind: 'section' }> | null = null;
  for (const entry of entries) {
    if (entry.kind === 'section') {
      pendingSection = entry;
      continue;
    }
    if (pendingSection) {
      blocks.push({
        key: `section:${pendingSection.id}`,
        heading: pendingSection.heading,
        photos: [],
      });
      pendingSection = null;
    } else if (blocks.length === 0) {
      blocks.push({ key: 'lead', heading: null, photos: [] });
    }
    position += 1;
    blocks.at(-1)!.photos.push({ entry, position });
  }
  return blocks;
}

interface PublicAlbumProps {
  album: PublicAlbumView;
  /**
   * Where one photo's bytes come from. The recipient page reads through the album-share
   * credential it exchanged; Manager Preview reads the same album through ordinary Manager
   * authentication. Passing the resolver in keeps the renderer from knowing either credential,
   * so the cover and every body photo can only ever take the one path its caller authorized.
   */
  imageSource: (mediaId: string) => string;
  /**
   * The recipient page is the album and owns the page landmark. Manager Preview renders the same
   * album inside the manager's own landmark, which may not contain a second one.
   */
  variant: 'page' | 'embedded';
}

export function PublicAlbum({ album, imageSource, variant }: PublicAlbumProps) {
  const Frame = variant === 'page' ? 'main' : 'section';
  const Title = variant === 'page' ? 'h1' : 'h3';
  const SectionHeading = variant === 'page' ? 'h2' : 'h4';
  return <Frame className="public-album">
    <header className="public-album__intro">
      {album.coverMediaId && <AlbumImage
        key={album.coverMediaId}
        src={imageSource(album.coverMediaId)}
        alt={`Cover for ${album.title}`}
        className="public-album__cover"
      />}
      <div className="public-album__copy">
        <Title>{album.title}</Title>
        {album.description && <p>{album.description}</p>}
        <span>{album.photoCount} {album.photoCount === 1 ? 'photo' : 'photos'}</span>
      </div>
    </header>

    <div className="public-album__blocks">
      {album.photoCount === 0
        ? <p className="public-album__empty">No photos in this Album yet.</p>
        : publicAlbumBlocks(album.entries).map((block) => <section
            className="public-album__block"
            key={block.key}
          >
            {block.heading
              && <SectionHeading className="public-album__section">{block.heading}</SectionHeading>}
            <div className="public-album__photos">
              {block.photos.map(({ entry, position }) => {
                const label = entry.photo.caption?.trim() || `Album photo ${position}`;
                return <figure className="public-album__photo" key={entry.photo.id}>
                  {entry.photo.previewAvailable
                    ? <AlbumImage
                        src={imageSource(entry.photo.id)}
                        alt={label}
                      />
                    : <AlbumPreviewFallback label={label} />}
                  {entry.photo.caption && <figcaption>{entry.photo.caption}</figcaption>}
                </figure>;
              })}
            </div>
          </section>)}
    </div>
  </Frame>;
}

import { ImageOff } from 'lucide-react';
import { useState } from 'react';

import { mediaPreview } from '../../app/api';
import type { AlbumEntryView } from '../../../shared/contracts';
import { galleryPhotoTitle } from './gallery-timeline';

interface AlbumPreviewProps {
  entries: readonly AlbumEntryView[];
  title: string;
  description: string;
}

interface PreviewBlock {
  key: string;
  heading: string | null;
  photos: Array<Extract<AlbumEntryView, { kind: 'photo' }>>;
}

function previewBlocks(entries: readonly AlbumEntryView[]): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  for (const entry of entries) {
    if (entry.kind === 'section') {
      blocks.push({ key: `section:${entry.id}`, heading: entry.heading, photos: [] });
      continue;
    }
    if (blocks.length === 0) blocks.push({ key: 'lead', heading: null, photos: [] });
    blocks.at(-1)!.photos.push(entry);
  }
  return blocks;
}

function PreviewPhoto({ entry }: { entry: Extract<AlbumEntryView, { kind: 'photo' }> }) {
  const [failed, setFailed] = useState(false);
  const title = galleryPhotoTitle(entry.photo);
  const label = `${title}, from ${entry.photo.guestName}`;
  if (!entry.photo.previewAvailable || failed) {
    return <div className="album-preview__placeholder" role="img" aria-label={label}>
      <ImageOff aria-hidden="true" />
      <span>Preview unavailable</span>
    </div>;
  }
  return <img
    src={mediaPreview(entry.photo.id)}
    alt={label}
    loading="lazy"
    decoding="async"
    onError={() => setFailed(true)}
  />;
}

/** The guest-facing reading order, rendered inline so editing and preview never compete. */
export function AlbumPreview({ entries, title, description }: AlbumPreviewProps) {
  return <section className="album-preview" aria-labelledby="album-preview-title">
    <p className="section-label">What a guest opening the link sees</p>
    <h3 id="album-preview-title">{title}</h3>
    {description && <p className="album-preview__description">{description}</p>}
    <div className="album-preview__blocks">
      {previewBlocks(entries).map((block) => <section className="album-preview__block" key={block.key}>
        {block.heading && <h4>{block.heading}</h4>}
        {block.photos.length > 0 && <div className="album-preview__photos">
          {block.photos.map((entry) => <PreviewPhoto entry={entry} key={entry.photo.id} />)}
        </div>}
      </section>)}
    </div>
  </section>;
}

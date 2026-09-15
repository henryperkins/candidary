import { ImageOff } from 'lucide-react';
import { useRef, useState } from 'react';

import { mediaPreview } from '../../app/api';
import type { GuestGalleryMediaView } from '../../app/types';
import './guest-gallery.css';

export function GuestGalleryPhoto({ photo, fullscreen = false, eager = false }: {
  photo: GuestGalleryMediaView;
  fullscreen?: boolean;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const figure = useRef<HTMLElement>(null);
  // Device filenames are deliberately absent from the guest's public caption.
  const title = photo.caption || 'Shared photo';
  const unavailable = failed || !photo.previewAvailable;

  function retryPreview() {
    // The retry button disappears when the image returns. Keep keyboard users
    // at this photo instead of letting focus fall back to the document body.
    figure.current?.focus({ preventScroll: true });
    setAttempt((current) => current + 1);
    setFailed(false);
    setAnnouncement(`Retrying preview: ${title}.`);
  }

  return <figure id={`guest-gallery-photo-${photo.id}`} ref={figure} tabIndex={-1} className={`guest-gallery-photo${unavailable ? ' guest-gallery-photo--unavailable' : ''}`}>
    {unavailable
      ? <div className="guest-gallery-photo__fallback">
          <ImageOff aria-hidden="true" />
          <span>Preview unavailable</span>
          {photo.previewAvailable && <button type="button" className="button button--secondary" onClick={retryPreview}>Retry preview</button>}
        </div>
      : <img
          src={`${mediaPreview(photo.id)}${attempt ? `?retry=${attempt}` : ''}`}
          alt={title}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => { setFailed(true); setAnnouncement(`Preview unavailable: ${title}.`); }}
          onLoad={() => { if (attempt > 0) setAnnouncement(`Preview loaded: ${title}.`); }}
        />}
    <figcaption>{fullscreen ? title : <><span>{title}</span><small>by {photo.guestName}</small></>}</figcaption>
    <span className="sr-only" role="status">{announcement}</span>
  </figure>;
}

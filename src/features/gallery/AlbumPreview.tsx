import { X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { mediaPreview } from '../../app/api';
import type { AlbumEntryView } from '../../../shared/contracts';
import { galleryPhotoTitle } from './gallery-timeline';

interface AlbumPreviewProps {
  entries: readonly AlbumEntryView[];
  eventName: string;
  onClose(): void;
}

/**
 * The album as the host arranged it, read rather than edited.
 *
 * This is the one surface in the manager where the photographs are the content and the
 * interface should get out of the way, so the controls are a single close button and the
 * page is the sequence itself. Sections become real headings with the space a chapter
 * break needs; without them the album is one continuous run, which is also a legitimate
 * album and not an empty state.
 *
 * Containment matches `GalleryViewer`: `aria-modal` alone leaves the manager shell
 * tabbable behind the dialog, so the other body children are inerted for as long as this
 * is open. Focus restoration stays with the caller, which knows which control opened it.
 */
export function AlbumPreview({ entries, eventName, onClose }: AlbumPreviewProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [host] = useState(() => document.createElement('div'));
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set());

  useLayoutEffect(() => {
    document.body.append(host);
    const inerted: HTMLElement[] = [];
    for (const sibling of Array.from(document.body.children)) {
      if (sibling === host || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute('inert')) continue;
      sibling.setAttribute('inert', '');
      inerted.push(sibling);
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      for (const sibling of inerted) sibling.removeAttribute('inert');
      document.body.style.overflow = previousOverflow;
      host.remove();
    };
  }, [host]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable?.[0];
      const last = focusable?.[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const photoCount = entries.filter((entry) => entry.kind === 'photo').length;

  return createPortal(<div
    className="album-preview"
    role="dialog"
    aria-modal="true"
    aria-labelledby="album-preview-title"
    ref={dialogRef}
  >
    <header className="album-preview__bar">
      <div>
        <h2 id="album-preview-title">{eventName}</h2>
        <p>{photoCount} photo{photoCount === 1 ? '' : 's'} · private to hosts</p>
      </div>
      <button
        type="button"
        className="album-preview__close"
        ref={closeRef}
        aria-label="Close album preview"
        onClick={onClose}
      ><X aria-hidden="true" /></button>
    </header>

    <div className="album-preview__page">
      {entries.map((entry) => {
        if (entry.kind === 'section') {
          return <h3 className="album-preview__section" key={`section:${entry.id}`}>{entry.heading}</h3>;
        }
        const title = galleryPhotoTitle(entry.photo);
        const failed = failedIds.has(entry.photo.id);
        return <figure className="album-preview__figure" key={`photo:${entry.photo.id}`}>
          {entry.photo.previewAvailable && !failed
            ? <img
                src={mediaPreview(entry.photo.id)}
                alt={title}
                width={entry.photo.width ?? undefined}
                height={entry.photo.height ?? undefined}
                loading="lazy"
                decoding="async"
                onError={() => setFailedIds((current) => new Set(current).add(entry.photo.id))}
              />
            : <div className="album-preview__placeholder">
                <strong>{entry.photo.originalFilename}</strong>
                <span>Preview unavailable. This photo was delivered and is included in your download.</span>
              </div>}
          <figcaption>
            <strong>{title}</strong>
            <span>From {entry.photo.guestName}</span>
          </figcaption>
        </figure>;
      })}
    </div>
  </div>, host);
}

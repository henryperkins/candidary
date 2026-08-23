import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExportDownloadView, ExportView, MediaView } from '../../app/types';
import type { EventView } from '../../../shared/contracts';
import { fetchAlbum } from './album-api';
import { GalleryExportControl } from './GalleryExportControl';
import { ManagerAlbum } from './ManagerAlbum';
import { ManagerPrivateGallery } from './ManagerPrivateGallery';
import { ManagerSharedGallery, type GallerySharedStatus } from './ManagerSharedGallery';
import type { Dispatch, SetStateAction } from 'react';

type GalleryMode = 'library' | 'album' | 'shared';

/**
 * Keyed by the mode union rather than matched with a fallback, so a fourth mode is a
 * compile error here instead of an unlabelled tab.
 */
const MODE_LABELS: Record<GalleryMode, string> = {
  library: 'Library',
  album: 'Album',
  shared: 'Shared',
};

/**
 * What each mode holds, said once, where a host chooses between them. Three modes is one
 * more than most people will read a label for, and the difference that matters — which of
 * these is visible to guests — is not inferable from the names.
 */
const MODE_NOTES: Record<GalleryMode, string> = {
  library: 'Every photo guests have delivered. Private to hosts.',
  album: 'Your curated album. Private to hosts — picking a photo never publishes it.',
  shared: 'What guests can see right now. Only this mode publishes.',
};

interface ManagerGalleryWorkspaceProps {
  event: EventView;
  eventId: string;
  shared: {
    media: MediaView[];
    status: GallerySharedStatus;
    selected: string[];
    selectionAtLimit: boolean;
    onStatusChange(status: GallerySharedStatus): void;
    onSelectedChange: Dispatch<SetStateAction<string[]>>;
    onBulk(action: 'publish' | 'hide'): Promise<void>;
    onChangePublication(item: MediaView, action: 'publish' | 'hide'): Promise<void>;
    loadingMore: boolean;
    hasMore: boolean;
    onLoadMore(): Promise<void>;
    onOpenSettings(): void;
    settingsBlocked: boolean;
  };
  exports: {
    job?: ExportView;
    download?: ExportDownloadView;
    onPrepare(): Promise<void>;
    onDownload(job: ExportView): Promise<void>;
    onRetry(job: ExportView): Promise<void>;
  };
}

/**
 * The one Gallery destination. Library is every private submission, Album is the host's
 * curated artifact, Shared is the publication workspace — and the complete export stays on
 * Library, because `Download all` is whole-event and independent of search, picks and
 * arrangement.
 *
 * The album's photo count is owned here rather than in either mode, because both need it
 * and they must not disagree: Library labels its filter with it while Album is unmounted,
 * and Album changes it while Library is unmounted.
 */
export function ManagerGalleryWorkspace({ event, eventId, shared, exports }: ManagerGalleryWorkspaceProps) {
  const [mode, setMode] = useState<GalleryMode>('library');
  const [pickCount, setPickCount] = useState(0);
  const pickGeneration = useRef(0);

  const refreshPickCount = useCallback(() => {
    const generation = ++pickGeneration.current;
    // A count is decoration on every surface that shows it: a failed read leaves the last
    // good number rather than replacing the filter's label with an error.
    fetchAlbum(eventId)
      .then((result) => {
        if (generation === pickGeneration.current) setPickCount(result.album.photoCount);
      })
      .catch(() => {});
  }, [eventId]);

  useEffect(refreshPickCount, [refreshPickCount]);

  return <section className="manager-gallery" aria-labelledby="gallery-workspace-title">
    <div className="workspace-heading">
      <h2 id="gallery-workspace-title">Gallery</h2>
      <div className="gallery-mode-switch gallery-mode-switch--three" role="group" aria-label="Gallery mode">
        {(['library', 'album', 'shared'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={mode === value}
            className={mode === value ? 'active' : ''}
            onClick={() => setMode(value)}
          >{MODE_LABELS[value]}{value === 'album' && pickCount > 0 ? ` (${pickCount})` : ''}</button>
        ))}
      </div>
      <p className="gallery-mode-note">{MODE_NOTES[mode]}</p>
    </div>

    <div className="gallery-private-mode" hidden={mode !== 'library'}>
      <div className="gallery-header">
        <p className="gallery-total">{event.storedMediaCount.toLocaleString()} photos</p>
        <GalleryExportControl
          job={exports.job}
          download={exports.download}
          onPrepare={exports.onPrepare}
          onDownload={exports.onDownload}
          onRetry={exports.onRetry}
        />
      </div>
      <ManagerPrivateGallery
        event={event}
        eventId={eventId}
        active={mode === 'library'}
        pickCount={pickCount}
        onPicksChanged={refreshPickCount}
      />
    </div>

    {/* Mounted only while chosen, unlike the other two. Album holds an unsaved arrangement
        and a live undo offer; keeping it alive behind `hidden` would let a nine-second undo
        expire on a surface the host cannot see it on. */}
    {mode === 'album' && <div className="gallery-album-mode">
      <ManagerAlbum
        event={event}
        eventId={eventId}
        active={mode === 'album'}
        onPicksChanged={refreshPickCount}
      />
    </div>}

    <div className="gallery-shared-mode" hidden={mode !== 'shared'}>
      <ManagerSharedGallery event={event} {...shared} />
    </div>
  </section>;
}

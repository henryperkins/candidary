import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { ExportDownloadView, ExportView, MediaView } from '../../app/types';
import type { EventView, ExportKind } from '../../../shared/contracts';
import type { LoadFailure } from '../../components/States';
import type { DomainAutosaveState } from '../settings/autosave-queue';
import { fetchAlbum } from './album-api';
import { GalleryExportControl } from './GalleryExportControl';
import { ManagerAlbum, type ManagerAlbumHandle } from './ManagerAlbum';
import { ManagerPrivateGallery } from './ManagerPrivateGallery';
import { ManagerSharedGallery, type GallerySharedStatus } from './ManagerSharedGallery';
import { selectionCapacityMessage } from './selection-state';
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
  library: 'Everything delivered privately, newest first. Picking a photo adds it to the album for every host on this event — it does not publish it.',
  album: 'One album per event. Its order and sections are yours; the delivered originals stay exactly where they are.',
  shared: 'What guests can see right now. Publishing and hiding change the shared gallery only.',
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
    albumJob?: ExportView;
    activeJob?: ExportView;
    download?: ExportDownloadView;
    albumDownload?: ExportDownloadView;
    onPrepare(kind?: ExportKind): Promise<void>;
    onDownload(job: ExportView): Promise<void>;
    onRetry(job: ExportView): Promise<void>;
  };
  onAlbumAutosaveStateChange?(state: DomainAutosaveState): void;
  onAlbumAccessFailure?(failure: LoadFailure | null): void;
}

export interface ManagerGalleryWorkspaceHandle {
  prepareToLeave(): Promise<boolean>;
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
export const ManagerGalleryWorkspace = forwardRef<
ManagerGalleryWorkspaceHandle,
ManagerGalleryWorkspaceProps
>(function ManagerGalleryWorkspace({
  event,
  eventId,
  shared,
  exports,
  onAlbumAutosaveStateChange,
  onAlbumAccessFailure,
}, ref) {
  const [mode, setMode] = useState<GalleryMode>('library');
  const [pickCount, setPickCount] = useState(0);
  const [albumEntryCount, setAlbumEntryCount] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [liveHost] = useState(() => {
    const element = document.createElement('div');
    element.dataset.galleryLiveHost = 'true';
    return element;
  });
  const pickGeneration = useRef(0);
  const albumRef = useRef<ManagerAlbumHandle>(null);
  const modeTransitionPending = useRef(false);

  const refreshPickCount = useCallback(() => {
    const generation = ++pickGeneration.current;
    // A count is decoration on every surface that shows it: a failed read leaves the last
    // good number rather than replacing the filter's label with an error.
    fetchAlbum(eventId)
      .then((result) => {
        if (generation !== pickGeneration.current) return;
        setPickCount(result.album.photoCount);
        setAlbumEntryCount(result.album.entries.length);
      })
      .catch(() => {});
  }, [eventId]);

  // The viewer makes the application shell inert. Gallery owns one persistent live
  // region in a sibling body host so movement inside that portal remains announceable
  // without adding a second competing status node to the dialog.
  useLayoutEffect(() => {
    document.body.append(liveHost);
    return () => { liveHost.remove(); };
  }, [liveHost]);

  // Clear the previous event's announcement before child passive effects forward their
  // initial state. Clearing it in the passive reset below ran after those child effects and
  // erased ready or failed export news before Gallery's one live region could expose it.
  useLayoutEffect(() => {
    setAnnouncement('');
  }, [eventId]);

  useEffect(() => {
    setMode('library');
    setPickCount(0);
    setAlbumEntryCount(0);
    pickGeneration.current += 1;
    refreshPickCount();
  }, [eventId, refreshPickCount]);

  const prepareToLeave = useCallback(async () => {
    if (mode !== 'album') return true;
    const ready = await albumRef.current?.prepareToLeave() ?? true;
    if (ready) onAlbumAutosaveStateChange?.({
      domain: 'album',
      label: 'Album',
      status: 'saved',
      failure: null,
      blockingField: null,
    });
    return ready;
  }, [mode, onAlbumAutosaveStateChange]);

  useImperativeHandle(ref, () => ({ prepareToLeave }), [prepareToLeave]);

  useEffect(() => {
    if (mode !== 'shared') return;
    setAnnouncement(shared.selectionAtLimit
      ? selectionCapacityMessage()
      : shared.selected.length
        ? `${shared.selected.length} selected`
        : 'Select photos to update the optional gallery');
  }, [mode, shared.selected.length, shared.selectionAtLimit]);

  async function changeMode(next: GalleryMode) {
    if (next === mode || modeTransitionPending.current) return;
    if (mode === 'album') {
      modeTransitionPending.current = true;
      try {
        if (await prepareToLeave() === false) return;
      } finally {
        modeTransitionPending.current = false;
      }
    }
    if (mode === 'shared' && shared.selected.length > 0) {
      shared.onSelectedChange([]);
    }
    setMode(next);
  }

  return <>
    {createPortal(
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>,
      liveHost,
    )}
    <section className="manager-gallery" aria-labelledby="gallery-workspace-title">
    <div className="workspace-heading">
      <h2 id="gallery-workspace-title">Gallery</h2>
      <div className="gallery-mode-switch gallery-mode-switch--three" role="group" aria-label="Gallery mode">
        {(['library', 'album', 'shared'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={mode === value}
            className={mode === value ? 'active' : ''}
            onClick={() => { void changeMode(value); }}
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
          activeJob={exports.activeJob}
          download={exports.download}
          onPrepare={exports.onPrepare}
          onDownload={exports.onDownload}
          onRetry={exports.onRetry}
          live={false}
          onAnnouncement={setAnnouncement}
        />
      </div>
      <ManagerPrivateGallery
        event={event}
        eventId={eventId}
        active={mode === 'library'}
        pickCount={pickCount}
        albumEntryCount={albumEntryCount}
        onPicksChanged={refreshPickCount}
        live={false}
        onAnnouncement={setAnnouncement}
      />
    </div>

    {/* Mounted only while chosen, unlike the other two. Album holds an unsaved arrangement
        and a live undo offer; keeping it alive behind `hidden` would let a nine-second undo
        expire on a surface the host cannot see it on. */}
    {mode === 'album' && <div className="gallery-album-mode">
      <ManagerAlbum
        key={eventId}
        ref={albumRef}
        eventId={eventId}
        active={mode === 'album'}
        onGoToLibrary={() => { void changeMode('library'); }}
        onPicksChanged={refreshPickCount}
        exportJob={exports.albumJob}
        activeExport={exports.activeJob}
        exportDownload={exports.albumDownload}
        onPrepareExport={() => exports.onPrepare('album')}
        onDownloadExport={exports.onDownload}
        onRetryExport={exports.onRetry}
        onAutosaveStateChange={onAlbumAutosaveStateChange}
        onAccessFailure={onAlbumAccessFailure}
        onAnnouncement={setAnnouncement}
      />
    </div>}

    <div className="gallery-shared-mode" hidden={mode !== 'shared'}>
      <ManagerSharedGallery
        event={event}
        {...shared}
        onAnnouncement={setAnnouncement}
      />
    </div>
    </section>
  </>;
});

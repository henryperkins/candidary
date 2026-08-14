import { useState } from 'react';

import type { ExportDownloadView, ExportView, MediaView } from '../../app/types';
import type { EventView } from '../../../shared/contracts';
import { GalleryExportControl } from './GalleryExportControl';
import { ManagerPrivateGallery } from './ManagerPrivateGallery';
import { ManagerSharedGallery, type GallerySharedStatus } from './ManagerSharedGallery';
import type { Dispatch, SetStateAction } from 'react';

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
 * The one Gallery destination: private timeline by default, the extracted
 * publication workspace as the secondary mode, and a single complete-export
 * entry point on the private side.
 */
export function ManagerGalleryWorkspace({ event, eventId, shared, exports }: ManagerGalleryWorkspaceProps) {
  const [mode, setMode] = useState<'private' | 'shared'>('private');
  return <section className="manager-gallery" aria-labelledby="gallery-workspace-title">
    <div className="workspace-heading">
      <div>
        <p className="section-label">{mode === 'private' ? 'Private memory library' : 'Optional shared view'}</p>
        <h2 id="gallery-workspace-title">{mode === 'private' ? 'Private gallery' : 'Shared gallery'}</h2>
      </div>
      <div className="gallery-mode-switch" role="group" aria-label="Gallery mode">
        <button
          type="button"
          aria-pressed={mode === 'private'}
          className={mode === 'private' ? 'active' : ''}
          onClick={() => setMode('private')}
        >Private gallery</button>
        <button
          type="button"
          aria-pressed={mode === 'shared'}
          className={mode === 'shared' ? 'active' : ''}
          onClick={() => setMode('shared')}
        >Shared gallery</button>
      </div>
    </div>
    {mode === 'private'
      ? <div className="gallery-private-mode">
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
          <ManagerPrivateGallery event={event} eventId={eventId} />
        </div>
      : <ManagerSharedGallery event={event} {...shared} />}
  </section>;
}

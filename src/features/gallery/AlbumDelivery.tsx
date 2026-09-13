import { ChevronDown, CloudUpload, Download, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import type { ExportDownloadView, ExportView } from '../../app/types';
import { AlbumExportControl } from './AlbumExportControl';
import { exportWaitMessage, hasTrustedEmptySource, type ExportCurrentSource } from './export-control-status';

interface AlbumDeliveryProps {
  heading: ReactNode;
  eventTimezone: string;
  currentSource: ExportCurrentSource;
  job?: ExportView;
  activeJob?: ExportView;
  download?: ExportDownloadView;
  blockedReason?: string;
  onPrepare(): Promise<void>;
  onDownload(job: ExportView): Promise<void>;
  onRetry(job: ExportView): Promise<void>;
  onAnnouncement?(message: string): void;
  actionArea?: ReactNode;
  chooser?: ReactNode;
}

export function AlbumDelivery({ heading, eventTimezone, currentSource, job, activeJob, download,
  blockedReason, onPrepare, onDownload, onRetry, onAnnouncement, actionArea, chooser }: AlbumDeliveryProps) {
  const [panel, setPanel] = useState<'connections' | 'download' | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const exportButton = useRef<HTMLButtonElement>(null);
  const downloadButton = useRef<HTMLButtonElement>(null);
  const wait = exportWaitMessage(activeJob, job?.id) ?? blockedReason;
  const jobPreparing = job?.state === 'queued' || job?.state === 'running';
  const disabledReason = wait ?? (hasTrustedEmptySource(currentSource) ? 'Add photos from Library to download your album.' : undefined);

  async function prepareDownload() {
    if (busy.current || disabledReason || jobPreparing) return;
    busy.current = true;
    setPreparing(true);
    setError(null);
    setPanel('download');
    try { await onPrepare(); }
    catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your album could not be prepared. Try Download Album again.');
    } finally {
      busy.current = false;
      setPreparing(false);
    }
  }

  function closePanel() {
    const origin = panel === 'connections' ? exportButton : downloadButton;
    setPanel(null);
    origin.current?.focus();
  }

  const visiblePanel = chooser ? 'download' : panel;

  return <div className="album-delivery">
    <div className="album-delivery__header">
      {heading}
      <div className="album-delivery__actions">
        <button type="button" className="button button--secondary" ref={exportButton}
          aria-expanded={visiblePanel === 'connections'} aria-controls="album-connections"
          onClick={() => setPanel(current => current === 'connections' ? null : 'connections')}>
          <CloudUpload aria-hidden="true" /> Export <ChevronDown aria-hidden="true" />
        </button>
        <button type="button" className="button button--primary" ref={downloadButton}
          disabled={preparing || !!disabledReason}
          aria-describedby={disabledReason ? 'album-download-reason' : undefined}
          aria-expanded={visiblePanel === 'download'} aria-controls="album-download-panel"
          onClick={() => { if (jobPreparing) setPanel('download'); else void prepareDownload(); }}>
          <Download aria-hidden="true" />
          {preparing ? 'Preparing…' : jobPreparing ? 'View progress' : 'Download Album'}
        </button>
      </div>
    </div>
    {disabledReason && <p className="album-delivery__reason" id="album-download-reason">{disabledReason}</p>}
    {visiblePanel === 'connections' && <section className="album-connections" id="album-connections" aria-labelledby="album-connections-title"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closePanel(); } }}>
      <div className="album-delivery__panel-heading">
        <h4 id="album-connections-title">Export to</h4>
        <button type="button" className="icon-button" aria-label="Close export destinations" onClick={closePanel}><X aria-hidden="true" /></button>
      </div>
      <p>Direct connections are coming soon. You can download your album now.</p>
      <div className="album-connections__list" role="group" aria-label="Future album connections">
        {['OneDrive', 'Google Photos', 'iCloud'].map(destination => <button type="button" className="album-connection" disabled key={destination} aria-label={`${destination} Coming soon`}>
          <span>{destination}</span><span className="album-connection__status">Coming soon</span>
        </button>)}
      </div>
    </section>}
    {visiblePanel === 'download' && <section className="album-download-panel" id="album-download-panel" aria-labelledby="album-download-title">
      <div className="album-delivery__panel-heading">
        <h4 id="album-download-title">Album download</h4>
        {!chooser && <button type="button" className="icon-button" aria-label="Close album download" onClick={closePanel}><X aria-hidden="true" /></button>}
      </div>
      {preparing && <p role="status">Preparing your album in its saved order…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <AlbumExportControl eventTimezone={eventTimezone} currentSource={currentSource}
        job={job} activeJob={activeJob} download={download} prepareBlockedReason={blockedReason}
        onPrepare={onPrepare} onDownload={onDownload} onRetry={onRetry} onAnnouncement={onAnnouncement}
        showPrepareAction={false} actionArea={actionArea} chooser={chooser} />
    </section>}
    {visiblePanel !== 'download' && job && <button type="button" className="text-button album-delivery__receipt" onClick={() => setPanel('download')}>
      {jobPreparing ? 'Album ZIP is being prepared' : job.state === 'ready' ? 'Your prepared download is ready' : 'View previous download'}
      <ChevronDown aria-hidden="true" />
    </button>}
  </div>;
}

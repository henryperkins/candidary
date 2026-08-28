import { Download } from 'lucide-react';
import { useState } from 'react';

import { formatBytes } from '../../app/format';
import type { ExportDownloadView, ExportView } from '../../app/types';
import {
  ExportJobStatus,
  describeCurrentSource,
  exportAnnouncementMessage,
  exportWaitMessage,
  hasTrustedEmptySource,
  isTerminalExport,
  useExportAnnouncement,
  type ExportCurrentSource,
} from './export-control-status';

interface AlbumExportControlProps {
  eventTimezone: string;
  currentSource: ExportCurrentSource;
  now?: number;
  job?: ExportView;
  activeJob?: ExportView;
  download?: ExportDownloadView;
  onPrepare(): Promise<void>;
  onDownload(job: ExportView): Promise<void>;
  onRetry(job: ExportView): Promise<void>;
  /** Retained while call sites move to Manager's one live owner; controls render no live nodes. */
  live?: boolean;
  onAnnouncement?(message: string): void;
}

/**
 * Album's original-download exit. It deliberately consumes only the photo
 * descriptors shared with complete exports; Guestbook artifacts are outside
 * this component's vocabulary and therefore cannot leak into the album UI.
 */
export function AlbumExportControl({
  eventTimezone,
  currentSource,
  now = Date.now(),
  job,
  activeJob,
  download,
  onPrepare,
  onDownload,
  onRetry,
  onAnnouncement,
}: AlbumExportControlProps) {
  const [pendingAction, setPendingAction] = useState<'prepare' | 'download' | 'retry' | null>(null);
  const waitMessage = exportWaitMessage(activeJob, job?.id);
  const currentSourceEmpty = hasTrustedEmptySource(currentSource);
  const run = (action: typeof pendingAction, request: () => Promise<void>) => {
    if (pendingAction !== null) return;
    setPendingAction(action);
    void request().finally(() => setPendingAction(null));
  };
  const liveMessage = job === undefined
    ? pendingAction === 'prepare' ? 'Preparing the current Album…' : ''
    : exportAnnouncementMessage(job, 'Album', now);
  useExportAnnouncement(liveMessage, onAnnouncement);
  const prepareDisabled = pendingAction !== null || waitMessage !== null || currentSourceEmpty;
  const prepareReason = waitMessage
    ?? (currentSourceEmpty ? 'Add a photo to the Album before preparing it.' : null);
  const currentCountCopy = describeCurrentSource(
    currentSource,
    currentSource.count ?? 0,
    'Album',
  );

  return <div className="gallery-export album-export">
    {job === undefined
      ? <>
          <p className="gallery-export__copy">
            {currentCountCopy} This is the Album only — Download all in Library stays the complete
            archive of every delivered original.
          </p>
          <button
            type="button"
            className="button button--primary"
            disabled={prepareDisabled}
            onClick={() => run('prepare', onPrepare)}
          >
            <Download aria-hidden="true" />
            {pendingAction === 'prepare' ? 'Preparing album download…' : 'Download album photos'}
          </button>
          {prepareReason === null ? null : <p className="gallery-export__copy">{prepareReason}</p>}
        </>
      : <div className="export-state">
          <ExportJobStatus
            job={job}
            eventTimezone={eventTimezone}
            currentSource={currentSource}
            currentLabel="Album"
            now={now}
          />
          {job.state === 'ready' && download === undefined
            ? <button
                type="button"
                className="button button--secondary"
                disabled={pendingAction !== null}
                onClick={() => run('download', () => onDownload(job))}
              >
                <Download aria-hidden="true" />
                {pendingAction === 'download' ? 'Getting download links…' : 'Get download links'}
              </button>
            : null}
          {download !== undefined
            ? <div className="export-links">
                {download.parts.length > 1
                  ? <p className="export-links__lead">
                      {download.parts.length} photo parts. Collect every one — each holds a different
                      set of photos.
                    </p>
                  : null}
                {download.manifest
                  ? <a href={download.manifest.url}>Photo manifest</a>
                  : null}
                {download.parts.map((part) => (
                  <a href={part.url} key={part.partNumber}>
                    Photo part {part.partNumber} of {download.parts.length}
                    <small>{part.mediaCount.toLocaleString()} photos · {formatBytes(part.sourceBytes)}</small>
                  </a>
                ))}
              </div>
            : null}
          {(job.state === 'failed' || job.state === 'expired')
            && job.errorCode !== 'EXPORT_SOURCE_REMOVED'
            ? <button
                type="button"
                className="button button--secondary"
                disabled={pendingAction !== null || waitMessage !== null}
                onClick={() => run('retry', () => onRetry(job))}
              >
                {pendingAction === 'retry' ? 'Retrying export…' : 'Retry this prepared export'}
              </button>
            : null}
          {isTerminalExport(job)
            ? <button
                type="button"
                className="button button--secondary"
                disabled={prepareDisabled}
                onClick={() => run('prepare', onPrepare)}
              >
                {pendingAction === 'prepare' ? 'Preparing current Album…' : 'Prepare current Album'}
              </button>
            : null}
          {isTerminalExport(job) && prepareReason !== null
            ? <p className="gallery-export__copy">{prepareReason}</p>
            : null}
        </div>}
  </div>;
}

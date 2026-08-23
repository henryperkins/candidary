import { Download } from 'lucide-react';
import { useState } from 'react';

import { formatBytes } from '../../app/format';
import type { ExportDownloadView, ExportView } from '../../app/types';

interface AlbumExportControlProps {
  photoCount: number;
  totalBytes: number;
  job?: ExportView;
  activeJob?: ExportView;
  download?: ExportDownloadView;
  onPrepare(): Promise<void>;
  onDownload(job: ExportView): Promise<void>;
  onRetry(job: ExportView): Promise<void>;
}

const EXPORT_STATE_LABELS: Record<ExportView['state'], string> = {
  queued: 'Preparing',
  running: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

function jobDetail(job: ExportView): string {
  const counts = `${job.mediaCount.toLocaleString()} photos · ${formatBytes(job.totalBytes)}`;
  if (job.state === 'queued' || job.state === 'running') {
    return `Preparing ${counts}. Download links last 24 hours.`;
  }
  if (job.state === 'ready') return `${counts}. Download links last 24 hours.`;
  if (job.state === 'failed') return `${counts}. Attempt ${job.attempt} failed.`;
  return `${counts}. The download links have expired.`;
}

/**
 * Album's original-download exit. It deliberately consumes only the photo
 * descriptors shared with complete exports; Guestbook artifacts are outside
 * this component's vocabulary and therefore cannot leak into the album UI.
 */
export function AlbumExportControl({
  photoCount,
  totalBytes,
  job,
  activeJob,
  download,
  onPrepare,
  onDownload,
  onRetry,
}: AlbumExportControlProps) {
  const [pendingAction, setPendingAction] = useState<'prepare' | 'download' | 'retry' | null>(null);
  const otherExportActive = activeJob !== undefined && activeJob.id !== job?.id;
  const run = (action: typeof pendingAction, request: () => Promise<void>) => {
    if (pendingAction !== null) return;
    setPendingAction(action);
    void request().finally(() => setPendingAction(null));
  };
  const liveMessage = job
    ? `${EXPORT_STATE_LABELS[job.state]}. ${jobDetail(job)}`
    : pendingAction === 'prepare' ? 'Preparing the album download…' : '';

  return <div className="gallery-export album-export">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveMessage}</p>
    {job === undefined
      ? <>
          <p className="gallery-export__copy">
            {photoCount.toLocaleString()} photos · {formatBytes(totalBytes)}. This is the album only —
            Download all in Library stays the complete archive of every delivered original.
          </p>
          <button
            type="button"
            className="button button--primary"
            disabled={photoCount === 0 || pendingAction !== null || otherExportActive}
            onClick={() => run('prepare', onPrepare)}
          >
            <Download aria-hidden="true" />
            {pendingAction === 'prepare' ? 'Preparing album download…' : 'Download album photos'}
          </button>
        </>
      : <div className="export-state">
          <strong>{EXPORT_STATE_LABELS[job.state]}</strong>
          <span>{jobDetail(job)}</span>
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
          {job.state === 'failed' || job.state === 'expired'
            ? <button
                type="button"
                className="button button--secondary"
                disabled={pendingAction !== null || otherExportActive}
                onClick={() => run('retry', () => onRetry(job))}
              >
                {pendingAction === 'retry' ? 'Retrying export…' : 'Retry export'}
              </button>
            : null}
        </div>}
  </div>;
}

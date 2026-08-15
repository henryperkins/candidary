import { Download } from 'lucide-react';
import { useState } from 'react';

import type { ExportDownloadView, ExportView } from '../../app/types';

interface GalleryExportControlProps {
  job?: ExportView;
  download?: ExportDownloadView;
  onPrepare(): Promise<void>;
  onDownload(job: ExportView): Promise<void>;
  onRetry(job: ExportView): Promise<void>;
}

/**
 * Keyed by the state union rather than matched with a fallback, so a new export state is a
 * compile error here instead of a job that silently claims to have expired.
 */
const EXPORT_STATE_LABELS: Record<ExportView['state'], string> = {
  queued: 'Preparing',
  running: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

function exportStateDetail(job: ExportView): string {
  const counts = `${job.mediaCount.toLocaleString()} photos · ${job.guestbookEntryCount ?? 0} guestbook entries`;
  if (job.state === 'ready') return `${counts}. Download links last 24 hours.`;
  if (job.state === 'failed') return `${counts}. Attempt ${job.attempt} failed.`;
  if (job.state === 'expired') return `${counts}. The download links have expired.`;
  return counts;
}

/**
 * The one Download all entry point. Before a job exists it is a single prepare
 * action; afterwards the ready-state download and retry controls remain part
 * of that same logical job rather than a second entry point.
 */
export function GalleryExportControl({
  job,
  download,
  onPrepare,
  onDownload,
  onRetry,
}: GalleryExportControlProps) {
  const [preparing, setPreparing] = useState(false);
  // One live region that outlives every branch below. A `role="status"` inserted alongside its own
  // first text is not announced, and the prepare button cannot carry the news either: it is disabled
  // the moment it is pressed, which blurs it. So the region is mounted empty and filled afterwards.
  const liveMessage = job
    ? `${EXPORT_STATE_LABELS[job.state]}. ${exportStateDetail(job)}`
    : preparing ? 'Preparing your download…' : '';
  return <div className="gallery-export">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveMessage}</p>
    {!job
      ? <>
          <p className="gallery-export__copy">
            Every private photo, the photo manifest, and the printable and private guestbook files. Search and favorites do not change this.
          </p>
          <button
            type="button"
            className="button button--primary"
            disabled={preparing}
            onClick={() => {
              setPreparing(true);
              void onPrepare().finally(() => setPreparing(false));
            }}
          >
            <Download aria-hidden="true" /> {preparing ? 'Preparing download…' : 'Download all'}
          </button>
        </>
      : <div className="export-state">
          <strong>{EXPORT_STATE_LABELS[job.state]}</strong>
          <span>{exportStateDetail(job)}</span>
          {job.state === 'ready' && !download && (
            <button type="button" className="button button--secondary" onClick={() => void onDownload(job)}>
              <Download aria-hidden="true" /> Get download links
            </button>
          )}
          {download && <div className="export-links">
            {download.manifest && <a href={download.manifest.url}>Photo manifest</a>}
            {download.parts.map((part) => (
              <a href={part.url} key={part.partNumber}>Photo part {part.partNumber} <small>{part.mediaCount} photos</small></a>
            ))}
            {download.printableGuestbook && <a href={download.printableGuestbook.url}>Printable guestbook</a>}
            {download.privateGuestbook && <a href={download.privateGuestbook.url}>Private entry archive <small>Contains entries guests cannot see</small></a>}
          </div>}
          {(job.state === 'failed' || job.state === 'expired') && (
            <button type="button" className="button button--secondary" onClick={() => void onRetry(job)}>
              Retry export
            </button>
          )}
        </div>}
  </div>;
}

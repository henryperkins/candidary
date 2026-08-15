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
  if (!job) {
    return <div className="gallery-export">
      <p className="gallery-export__copy">
        Every stored, non-deleted original, the photo manifest, and the printable and private
        Guestbook artifacts — one logical job. Search and favorites never narrow it.
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
        <Download aria-hidden="true" /> Download all
      </button>
    </div>;
  }
  return <div className="gallery-export">
    <div className="export-state">
      <strong>{job.state}</strong>
      <span>{job.mediaCount} photos · {job.guestbookEntryCount ?? 0} guestbook entries · attempt {job.attempt}</span>
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
    </div>
  </div>;
}

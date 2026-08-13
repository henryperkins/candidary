import { Download } from 'lucide-react';

import type { ExportDownloadView, ExportView } from '../app/types';

interface ManagerExportPanelProps {
  className?: string;
  job?: ExportView;
  download?: ExportDownloadView;
  onPrepare(): Promise<void>;
  onDownload(job: ExportView): Promise<void>;
  onRetry(job: ExportView): Promise<void>;
}

// One export presentation. The manager renders it twice — once in the wide utility rail and once in
// the Share section — and the stylesheet shows exactly one of them at any width, so the host never
// sees two copies of the same control.
export function ManagerExportPanel({ className, job, download, onPrepare, onDownload, onRetry }: ManagerExportPanelProps) {
  return <section className={className ? `manager-export-panel ${className}` : 'manager-export-panel'}>
    <p className="section-label">Complete export</p>
    <h2>Keep every original</h2>
    {job ? <div className="export-state">
      <strong>{job.state}</strong>
      <span>{job.mediaCount} photos · {job.guestbookEntryCount ?? 0} guestbook entries · attempt {job.attempt}</span>
      {job.state === 'ready' && !download && <button type="button" className="button button--secondary" onClick={() => void onDownload(job)}>
        <Download aria-hidden="true" /> Get download links
      </button>}
      {download && <div className="export-links">
        {download.manifest && <a href={download.manifest.url}>Photo manifest</a>}
        {download.parts.map((part) => <a href={part.url} key={part.partNumber}>Photo part {part.partNumber} <small>{part.mediaCount} photos</small></a>)}
        {download.printableGuestbook && <a href={download.printableGuestbook.url}>Printable guestbook</a>}
        {download.privateGuestbook && <a href={download.privateGuestbook.url}>Private entry archive <small>Contains entries guests cannot see</small></a>}
      </div>}
      {(job.state === 'failed' || job.state === 'expired') && <button type="button" className="button button--secondary" onClick={() => void onRetry(job)}>
        Retry export
      </button>}
    </div> : <>
      <p>Prepare every delivered original, whether or not it appears in the gallery.</p>
      <button type="button" className="button button--primary button--wide" onClick={() => void onPrepare()}>
        <Download aria-hidden="true" /> Prepare download
      </button>
    </>}
  </section>;
}

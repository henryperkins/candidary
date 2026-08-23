import { Download } from 'lucide-react';
import { useState } from 'react';

import { formatBytes } from '../../app/format';
import type { ExportDownloadView, ExportView } from '../../app/types';
import { EXPORT_STATE_LABELS, ExportStatusAnnouncement } from './export-control-status';

// Complete-export rendering predates the wire-level `kind` discriminator. Direct callers that
// still supply that legacy shape remain source-compatible; current API jobs retain the field.
export type LegacyCompleteExportView = Omit<ExportView, 'kind'> & { kind?: 'complete' };
type CompleteExportInput = ExportView | LegacyCompleteExportView;

export function normalizeCompleteExport(job: CompleteExportInput): ExportView {
  return { ...job, kind: job.kind ?? 'complete' };
}

interface GalleryExportControlProps {
  job?: CompleteExportInput;
  activeJob?: ExportView;
  download?: ExportDownloadView;
  onPrepare(): Promise<void>;
  onDownload(job: ExportView): Promise<void>;
  onRetry(job: ExportView): Promise<void>;
  live?: boolean;
  onAnnouncement?(message: string): void;
}

// A host planning a multi-gigabyte download needs the size before they start, not after.
// `totalBytes` and each part's `sourceBytes` were already on the wire and unused.
function exportStateDetail(job: ExportView): string {
  const counts = [
    `${job.mediaCount.toLocaleString()} photos`,
    formatBytes(job.totalBytes),
    `${job.guestbookEntryCount ?? 0} guestbook entries`,
  ].join(' · ');
  if (job.state === 'ready') return `${counts}. Download links last 24 hours.`;
  if (job.state === 'failed') return `${counts}. Attempt ${job.attempt} failed.`;
  if (job.state === 'expired') return `${counts}. The download links have expired.`;
  return counts;
}

/**
 * Past this the download is a sit-down task on a real connection, and saying so is kinder
 * than letting a host start it one-handed on a phone at the reception and lose it. The
 * product already knows the number; it just never said it.
 */
const DESKTOP_ADVISORY_BYTES = 2 * 1024 ** 3;

/**
 * The one Download all entry point. Before a job exists it is a single prepare
 * action; afterwards the ready-state download and retry controls remain part
 * of that same logical job rather than a second entry point.
 */
export function GalleryExportControl({
  job,
  activeJob,
  download,
  onPrepare,
  onDownload,
  onRetry,
  live = true,
  onAnnouncement,
}: GalleryExportControlProps) {
  const [preparing, setPreparing] = useState(false);
  const normalizedJob = job ? normalizeCompleteExport(job) : undefined;
  const otherExportActive = activeJob !== undefined && activeJob.id !== normalizedJob?.id;
  // One live region that outlives every branch below. A `role="status"` inserted alongside its own
  // first text is not announced, and the prepare button cannot carry the news either: it is disabled
  // the moment it is pressed, which blurs it. So the region is mounted outside the branch and filled
  // afterwards. It only speaks for changes that happen while the host is here: a job already running
  // when Gallery opens mounts the region full, which is why the state is also rendered visibly.
  const liveMessage = normalizedJob
    ? `${EXPORT_STATE_LABELS[normalizedJob.state]}. ${exportStateDetail(normalizedJob)}`
    : preparing ? 'Preparing your download…' : '';
  return <div className="gallery-export">
    <ExportStatusAnnouncement
      live={live}
      message={liveMessage}
      onAnnouncement={onAnnouncement}
    />
    {!normalizedJob
      ? <>
          <p className="gallery-export__copy">
            Every private photo, the photo manifest, and the printable and private guestbook files. Search and album picks do not change this.
          </p>
          <button
            type="button"
            className="button button--primary"
            disabled={preparing || otherExportActive}
            onClick={() => {
              setPreparing(true);
              void onPrepare().finally(() => setPreparing(false));
            }}
          >
            <Download aria-hidden="true" /> {preparing ? 'Preparing download…' : 'Download all'}
          </button>
        </>
      : <div className="export-state">
          <strong>{EXPORT_STATE_LABELS[normalizedJob.state]}</strong>
          <span>{exportStateDetail(normalizedJob)}</span>
          {normalizedJob.state === 'ready' && !download && (
            <button type="button" className="button button--secondary" onClick={() => void onDownload(normalizedJob)}>
              <Download aria-hidden="true" /> Get download links
            </button>
          )}
          {download && <div className="export-links">
            {download.parts.length > 1 && <p className="export-links__lead">
              {download.parts.length} photo parts. Collect every one — each holds a different
              set of photos.
            </p>}
            {normalizedJob.totalBytes >= DESKTOP_ADVISORY_BYTES && <p className="export-links__lead">
              This download is {formatBytes(normalizedJob.totalBytes)}. It is easier to finish on a
              computer than on a phone.
            </p>}
            {download.manifest && <a href={download.manifest.url}>Photo manifest</a>}
            {download.parts.map((part) => (
              <a href={part.url} key={part.partNumber}>
                Photo part {part.partNumber} of {download.parts.length}
                <small>{part.mediaCount.toLocaleString()} photos · {formatBytes(part.sourceBytes)}</small>
              </a>
            ))}
            {download.printableGuestbook && <a href={download.printableGuestbook.url}>Printable guestbook</a>}
            {download.privateGuestbook && <a href={download.privateGuestbook.url}>Private entry archive <small>Contains entries guests cannot see</small></a>}
          </div>}
          {(normalizedJob.state === 'failed' || normalizedJob.state === 'expired') && (
            <button
              type="button"
              className="button button--secondary"
              disabled={otherExportActive}
              onClick={() => void onRetry(normalizedJob)}
            >
              Retry export
            </button>
          )}
        </div>}
  </div>;
}

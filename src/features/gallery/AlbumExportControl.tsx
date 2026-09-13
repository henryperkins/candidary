import { Download } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { eventDateTimeDisplay } from '../../app/event-date-time';
import { formatBytes } from '../../app/format';
import type { ExportDownloadView, ExportView } from '../../app/types';
import {
  EXPORT_STATE_LABELS,
  coarseExportElapsed,
  describeCurrentSource,
  exportAnnouncementMessage,
  exportFailureMessage,
  exportProgressMessage,
  exportWaitMessage,
  hasTrustedEmptySource,
  useExportAnnouncement,
  type ExportCurrentSource,
} from './export-control-status';

interface AlbumExportControlProps {
  eventTimezone: string;
  currentSource: ExportCurrentSource;
  now?: number;
  job?: ExportView;
  activeJob?: ExportView;
  prepareBlockedReason?: string;
  download?: ExportDownloadView;
  onPrepare(): Promise<void>;
  onDownload(job: ExportView): Promise<void>;
  onRetry(job: ExportView): Promise<void>;
  /** Retained while call sites move to Manager's one live owner; controls render no live nodes. */
  live?: boolean;
  onAnnouncement?(message: string): void;
  actionArea?: ReactNode;
  chooser?: ReactNode;
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
  prepareBlockedReason,
  download,
  onPrepare,
  onDownload,
  onRetry,
  onAnnouncement,
  actionArea,
  chooser,
}: AlbumExportControlProps) {
  const [pendingAction, setPendingAction] = useState<'prepare' | 'download' | 'retry' | null>(null);
  const waitMessage = exportWaitMessage(activeJob, job?.id) ?? prepareBlockedReason ?? null;
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
  const prepared = job ? eventDateTimeDisplay(job.snapshotAt, eventTimezone) : null;
  const expiry = job?.expiresAt ? eventDateTimeDisplay(job.expiresAt, eventTimezone) : null;
  const preparing = job?.state === 'queued' || job?.state === 'running';
  const progress = job && (preparing || job.state === 'failed') ? exportProgressMessage(job) : null;
  const albumChanged = job && (job.state === 'ready' || job.state === 'expired')
    && currentSource.freshness === 'fresh' && currentSource.count !== null
    && currentSource.count !== job.mediaCount;

  return <div className="gallery-export album-export">
    <div className="album-export__current" role="group" aria-label="Current Album download">
      <p className="gallery-export__copy">{currentCountCopy}</p>
      <div className="album-export__actions">
        {!chooser && !preparing && <button
          type="button"
          className="button button--primary"
          disabled={prepareDisabled}
          onClick={() => run('prepare', onPrepare)}
        >
          <Download aria-hidden="true" />
          {pendingAction === 'prepare' ? 'Preparing Album ZIP…' : 'Prepare Album ZIP'}
        </button>}
        {actionArea}
      </div>
      {prepareReason === null ? null : <p className="gallery-export__copy">{prepareReason}</p>}
    </div>
    {chooser}
    {job && <div className="export-state album-export__prepared" role="group" aria-label="Prepared Album download">
      <div className="album-export__prepared-heading">
        <h4>{preparing ? 'Album ZIP' : 'Prepared download'}</h4>
        <strong>{EXPORT_STATE_LABELS[job.state]}</strong>
      </div>
      <p className="album-export__summary">
        {job.mediaCount.toLocaleString()} {job.mediaCount === 1 ? 'photo' : 'photos'} · {formatBytes(job.totalBytes)} of originals
      </p>
      {prepared && <span className="export-state__prepared">
        Prepared {prepared.dateTime === null ? prepared.value : <time dateTime={prepared.dateTime}>{prepared.value}</time>}
      </span>}
      {albumChanged && <p className="album-export__changed">Your Album has changed since this ZIP was prepared.</p>}
      {job.state === 'queued' && <span>Waiting to start.</span>}
      {job.state === 'running' && <span>{coarseExportElapsed(job.startedAt, now) ?? 'Preparing your Album ZIP…'}</span>}
      {progress && <span>{progress}</span>}
      {job.state === 'failed' && <span>{exportFailureMessage(job.errorCode ?? 'EXPORT_FAILED', 'Album')}</span>}
      {job.state === 'expired' && <span>This ZIP has expired. Retry this prepared export, or prepare a new Album ZIP.</span>}
      {job.state === 'ready' && download === undefined
        ? <button
            type="button"
            className="button button--secondary"
            disabled={pendingAction !== null}
            onClick={() => run('download', () => onDownload(job))}
          >
            <Download aria-hidden="true" />
            {pendingAction === 'download' ? 'Getting ZIP links…' : 'Show ZIP download'}
          </button>
        : null}
      {download !== undefined
        ? <div className="export-links">
            {download.parts.length > 1
              ? <p className="export-links__lead">
                  Download all {download.parts.length} ZIP parts to get every photo.
                </p>
              : null}
            {download.parts.map((part) => (
              <a href={part.url} key={part.partNumber}>
                <span>{download.parts.length === 1 ? 'Download Album ZIP' : `Download ZIP part ${part.partNumber} of ${download.parts.length}`}</span>
                <small>{part.mediaCount.toLocaleString()} {part.mediaCount === 1 ? 'photo' : 'photos'}</small>
              </a>
            ))}
            {download.manifest
              ? <a className="album-export__manifest" href={download.manifest.url}>Photo manifest</a>
              : null}
          </div>
        : null}
      {job.state === 'ready' && expiry && <span className="album-export__expiry">
        Links expire {expiry.dateTime === null ? expiry.value : <time dateTime={expiry.dateTime}>{expiry.value}</time>}.
      </span>}
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
    </div>}
  </div>;
}

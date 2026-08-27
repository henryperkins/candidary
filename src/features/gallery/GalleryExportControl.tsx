import { Download } from 'lucide-react';
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { formatBytes } from '../../app/format';
import type { ExportDownloadView, ExportView } from '../../app/types';
import {
  ExportJobStatus,
  exportAnnouncementMessage,
  exportWaitMessage,
  hasTrustedEmptySource,
  isTerminalExport,
  useExportAnnouncement,
  type ExportCurrentSource,
} from './export-control-status';

// Complete-export rendering predates the wire-level `kind` discriminator. Direct callers that
// still supply that legacy shape remain source-compatible; current API jobs retain the field.
export type LegacyCompleteExportView = Omit<ExportView, 'kind'> & { kind?: 'complete' };
type CompleteExportInput = ExportView | LegacyCompleteExportView;

export function normalizeCompleteExport(job: CompleteExportInput): ExportView {
  return { ...job, kind: job.kind ?? 'complete' };
}

interface GalleryExportControlProps {
  eventTimezone: string;
  currentSource: ExportCurrentSource;
  now?: number;
  job?: CompleteExportInput;
  activeJob?: ExportView;
  download?: ExportDownloadView;
  resourceStatus: 'idle' | 'loading' | 'ready' | 'failed';
  onPrepare(): Promise<void>;
  onDownload(job: ExportView): Promise<void>;
  onRetry(job: ExportView): Promise<void>;
  /** Retained while call sites move to Manager's one live owner; controls render no live nodes. */
  live?: boolean;
  onAnnouncement?(message: string): void;
}

export interface GalleryExportControlHandle {
  focusIntendedAction(): void;
  cancelIntendedAction(): void;
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
export const GalleryExportControl = forwardRef<
  GalleryExportControlHandle,
  GalleryExportControlProps
>(function GalleryExportControl({
  eventTimezone,
  currentSource,
  now = Date.now(),
  job,
  activeJob,
  download,
  resourceStatus,
  onPrepare,
  onDownload,
  onRetry,
  onAnnouncement,
}, ref) {
  const [pendingAction, setPendingAction] = useState<'prepare' | 'download' | 'retry' | null>(null);
  const [focusRequestEpoch, setFocusRequestEpoch] = useState(0);
  const focusRequested = useRef(false);
  const region = useRef<HTMLElement>(null);
  const initialPrepare = useRef<HTMLButtonElement>(null);
  const getDownloadLinks = useRef<HTMLButtonElement>(null);
  const manifestDownload = useRef<HTMLAnchorElement>(null);
  const firstPartDownload = useRef<HTMLAnchorElement>(null);
  const printableDownload = useRef<HTMLAnchorElement>(null);
  const privateDownload = useRef<HTMLAnchorElement>(null);
  const retryPrepared = useRef<HTMLButtonElement>(null);
  const prepareCurrent = useRef<HTMLButtonElement>(null);
  const normalizedJob = job ? normalizeCompleteExport(job) : undefined;
  const waitMessage = exportWaitMessage(activeJob, normalizedJob?.id);
  const currentSourceEmpty = hasTrustedEmptySource(currentSource);
  const liveMessage = normalizedJob === undefined
    ? pendingAction === 'prepare' ? 'Preparing the current collection…' : ''
    : exportAnnouncementMessage(normalizedJob, 'collection', now);
  useExportAnnouncement(liveMessage, onAnnouncement);
  const run = (action: Exclude<typeof pendingAction, null>, request: () => Promise<void>) => {
    if (pendingAction !== null) return;
    setPendingAction(action);
    void request().finally(() => setPendingAction(null));
  };

  const prepareDisabled = pendingAction !== null || waitMessage !== null || currentSourceEmpty;
  const prepareReason = waitMessage
    ?? (currentSourceEmpty ? 'Deliver a photo before preparing the current collection.' : null);

  useImperativeHandle(ref, () => ({
    focusIntendedAction() {
      focusRequested.current = true;
      setFocusRequestEpoch((current) => current + 1);
    },
    cancelIntendedAction() {
      focusRequested.current = false;
    },
  }), []);

  useLayoutEffect(() => {
    if (!focusRequested.current) return;
    // Continue the task the host already started. Resolved artifacts outrank
    // recovery/current-snapshot actions; otherwise resume the existing job
    // before offering a new snapshot. Explicit refs keep later DOM additions
    // from silently changing this order.
    let enabledAction: HTMLElement | null = null;
    if (resourceStatus === 'ready') {
      if (!normalizedJob) {
        enabledAction = initialPrepare.current?.disabled ? null : initialPrepare.current;
      } else {
        if (download) {
          enabledAction = manifestDownload.current
            ?? firstPartDownload.current
            ?? printableDownload.current
            ?? privateDownload.current;
        }
        if (!enabledAction && normalizedJob.state === 'ready') {
          enabledAction = getDownloadLinks.current?.disabled ? null : getDownloadLinks.current;
        }
        if (!enabledAction && (normalizedJob.state === 'failed' || normalizedJob.state === 'expired')) {
          enabledAction = retryPrepared.current?.disabled ? null : retryPrepared.current;
        }
        if (!enabledAction && isTerminalExport(normalizedJob)) {
          enabledAction = prepareCurrent.current?.disabled ? null : prepareCurrent.current;
        }
      }
    }
    if (enabledAction) {
      enabledAction.focus();
      focusRequested.current = false;
      return;
    }
    region.current?.focus();
  }, [
    currentSourceEmpty,
    download,
    focusRequestEpoch,
    normalizedJob?.state,
    pendingAction,
    resourceStatus,
    waitMessage,
  ]);

  return <section
    className="gallery-export"
    role="region"
    aria-label="Complete export"
    tabIndex={-1}
    ref={region}
  >
    <details className="gallery-export__details">
      <summary>What the complete download includes</summary>
      <p className="gallery-export__copy">
        Every delivered photo, the photo manifest, and the printable and private guestbook files. Search and Album picks do not change this.
      </p>
    </details>
    {!normalizedJob
      ? <>
          <button
            ref={initialPrepare}
            type="button"
            className="button button--primary"
            disabled={prepareDisabled}
            onClick={() => run('prepare', onPrepare)}
          >
            <Download aria-hidden="true" /> {pendingAction === 'prepare' ? 'Preparing download…' : 'Download all'}
          </button>
          {prepareReason === null ? null : <p className="gallery-export__copy">{prepareReason}</p>}
        </>
      : <div className="export-state">
          <ExportJobStatus
            job={normalizedJob}
            eventTimezone={eventTimezone}
            currentSource={currentSource}
            currentLabel="collection"
            now={now}
          />
          {normalizedJob.state === 'ready' && !download && (
            <button
              ref={getDownloadLinks}
              type="button"
              className="button button--secondary"
              disabled={pendingAction !== null}
              onClick={() => run('download', () => onDownload(normalizedJob))}
            >
              <Download aria-hidden="true" />
              {pendingAction === 'download' ? 'Getting download links…' : 'Get download links'}
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
            {download.manifest && <a ref={manifestDownload} href={download.manifest.url}>Photo manifest</a>}
            {download.parts.map((part, index) => (
              <a ref={index === 0 ? firstPartDownload : undefined} href={part.url} key={part.partNumber}>
                Photo part {part.partNumber} of {download.parts.length}
                <small>{part.mediaCount.toLocaleString()} photos · {formatBytes(part.sourceBytes)}</small>
              </a>
            ))}
            {download.printableGuestbook && <a ref={printableDownload} href={download.printableGuestbook.url}>Printable guestbook</a>}
            {download.privateGuestbook && <a ref={privateDownload} href={download.privateGuestbook.url}>Private entry archive <small>Contains entries guests cannot see</small></a>}
          </div>}
          {(normalizedJob.state === 'failed' || normalizedJob.state === 'expired')
            && normalizedJob.errorCode !== 'EXPORT_SOURCE_REMOVED'
            ? <button
                ref={retryPrepared}
                type="button"
                className="button button--secondary"
                disabled={pendingAction !== null || waitMessage !== null}
                onClick={() => run('retry', () => onRetry(normalizedJob))}
              >
                {pendingAction === 'retry' ? 'Retrying export…' : 'Retry this prepared export'}
              </button>
            : null}
          {isTerminalExport(normalizedJob)
            ? <button
                ref={prepareCurrent}
                type="button"
                className="button button--secondary"
                disabled={prepareDisabled}
                onClick={() => run('prepare', onPrepare)}
              >
                {pendingAction === 'prepare' ? 'Preparing current collection…' : 'Prepare current collection'}
              </button>
            : null}
          {isTerminalExport(normalizedJob) && prepareReason !== null
            ? <p className="gallery-export__copy">{prepareReason}</p>
            : null}
        </div>}
  </section>;
});

import { useEffect, type ReactElement } from 'react';

import type { ManagerExportErrorCode } from '../../../shared/contracts';
import { eventDateTimeDisplay } from '../../app/event-date-time';
import { formatBytes } from '../../app/format';
import type { ExportView } from '../../app/types';

/** Exhaustive visible and announced labels shared by both export surfaces. */
export const EXPORT_STATE_LABELS: Record<ExportView['state'], string> = {
  queued: 'Queued',
  running: 'Running',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

export interface ExportCurrentSource {
  count: number | null;
  freshness: 'fresh' | 'stale' | 'unavailable';
  /** A retained count can be stale while a reload runs or after that reload fails. */
  refreshing?: boolean;
}

export type ExportCurrentSourceLabel = 'collection' | 'Album';

export function isTerminalExport(job: ExportView): boolean {
  return job.state === 'ready' || job.state === 'failed' || job.state === 'expired';
}

export function hasTrustedEmptySource(source: ExportCurrentSource): boolean {
  return source.freshness === 'fresh' && source.count === 0;
}

function photoCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'}`;
}

/**
 * Numeric context only. Even equal trusted counts cannot prove that membership,
 * order, captions, or metadata still match the immutable prepared snapshot.
 */
export function describeCurrentSource(
  source: ExportCurrentSource,
  preparedCount: number,
  label: ExportCurrentSourceLabel,
): string {
  if (source.freshness === 'unavailable' || source.count === null) {
    return `Current ${label} count unavailable.`;
  }
  if (source.freshness === 'stale') {
    return source.refreshing
      ? `Last known current ${label}: ${photoCount(source.count)}. Refreshing the current count.`
      : `Last known current ${label}: ${photoCount(source.count)}. Current ${label} count unavailable.`;
  }
  const delta = source.count - preparedCount;
  const deltaCopy = delta === 0
    ? ''
    : ` (${delta > 0 ? '+' : ''}${delta.toLocaleString()} ${Math.abs(delta) === 1 ? 'photo' : 'photos'})`;
  return `Current ${label}: ${photoCount(source.count)}${deltaCopy}.`;
}

const FAILURE_MESSAGES: Record<ManagerExportErrorCode, string> = {
  EXPORT_SOURCE_MISSING: 'A source photo could not be read.',
  EXPORT_SOURCE_REMOVED: 'A photo in this prepared export is no longer available.',
  EXPORT_EVENT_DELETED: 'This event became unavailable while the export was being prepared.',
  EXPORT_GUESTBOOK_SNAPSHOT_INVALID: 'The prepared guestbook snapshot could not be completed.',
  EXPORT_SNAPSHOT_CHANGED: 'The prepared photo snapshot changed unexpectedly.',
  EXPORT_WORKFLOW_DISPATCH_FAILED: 'Export preparation could not start.',
  EXPORT_FAILED: 'This prepared export did not finish.',
};

/** A closed mapping: unknown Worker diagnostics never become Manager copy. */
export function exportFailureMessage(
  code: ExportView['errorCode'] | string,
  currentLabel: ExportCurrentSourceLabel,
): string {
  const safe = FAILURE_MESSAGES[code as ManagerExportErrorCode]
    ?? FAILURE_MESSAGES.EXPORT_FAILED;
  if (code === 'EXPORT_SOURCE_REMOVED') {
    return `${safe} Prepare the current ${currentLabel}.`;
  }
  if (code === 'EXPORT_EVENT_DELETED') {
    return `${safe} Reload Manager before choosing an action.`;
  }
  return `${safe} Retry this prepared export, or prepare the current ${currentLabel}.`;
}

export function coarseExportElapsed(startedAt: string | null, now: number): string | null {
  if (startedAt === null || !Number.isFinite(now)) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((now - started) / 1_000));
  if (elapsedSeconds < 60) return 'less than a minute elapsed.';
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes.toLocaleString()} ${minutes === 1 ? 'minute' : 'minutes'} elapsed.`;
  const hours = Math.floor(minutes / 60);
  return `${hours.toLocaleString()} ${hours === 1 ? 'hour' : 'hours'} elapsed.`;
}

export function exportProgressMessage(job: ExportView): string | null {
  const parts: string[] = [];
  if (typeof job.processedMediaCount === 'number') {
    parts.push(`${job.processedMediaCount.toLocaleString()} of ${photoCount(job.mediaCount)}`);
  }
  if (typeof job.processedBytes === 'number') {
    parts.push(`${formatBytes(job.processedBytes)} of ${formatBytes(job.totalBytes)}`);
  }
  return parts.length === 0 ? null : `Progress: ${parts.join(' · ')}.`;
}

function exportStateMessage(
  job: ExportView,
  currentLabel: ExportCurrentSourceLabel,
  now: number,
): string {
  switch (job.state) {
    case 'queued':
      return 'Waiting to start.';
    case 'running':
      return coarseExportElapsed(job.startedAt, now) ?? 'Preparation is running.';
    case 'ready':
      return 'Ready to download. Download links last 24 hours.';
    case 'failed':
      return exportFailureMessage(job.errorCode ?? 'EXPORT_FAILED', currentLabel);
    case 'expired':
      return `The download links expired. Retry this prepared export, or prepare the current ${currentLabel}.`;
  }
}

export function exportWaitMessage(
  activeJob: ExportView | undefined,
  displayedJobId: string | undefined,
): string | null {
  if (
    activeJob === undefined
    || activeJob.id === displayedJobId
    || (activeJob.state !== 'queued' && activeJob.state !== 'running')
  ) return null;
  const kind = activeJob.kind === 'album' ? 'Album' : 'Complete collection';
  return `${kind} export is ${EXPORT_STATE_LABELS[activeJob.state]}. Prepare and retry actions will be available when it finishes.`;
}

export function exportAnnouncementMessage(
  job: ExportView,
  currentLabel: ExportCurrentSourceLabel,
  now: number,
): string {
  const progress = exportProgressMessage(job);
  return [
    EXPORT_STATE_LABELS[job.state],
    exportStateMessage(job, currentLabel, now),
    progress,
  ].filter((part): part is string => part !== null).join(' ');
}

/** Controls forward changes to Manager's one persistent live owner; they own no live nodes. */
export function useExportAnnouncement(
  message: string,
  onAnnouncement: ((message: string) => void) | undefined,
): void {
  useEffect(() => {
    if (message) onAnnouncement?.(message);
  }, [message, onAnnouncement]);
}

/** One shared frozen/current status presentation consumed by both export controls. */
export function ExportJobStatus({
  job,
  eventTimezone,
  currentSource,
  currentLabel,
  now,
}: {
  job: ExportView;
  eventTimezone: string;
  currentSource: ExportCurrentSource;
  currentLabel: ExportCurrentSourceLabel;
  now: number;
}): ReactElement {
  const prepared = eventDateTimeDisplay(job.snapshotAt, eventTimezone);
  const progress = exportProgressMessage(job);
  const stateMessage = exportStateMessage(job, currentLabel, now);
  const guestbookCount = job.guestbookEntryCount ?? 0;
  const guestbook = job.kind === 'complete'
    ? ` · ${guestbookCount.toLocaleString()} guestbook ${guestbookCount === 1 ? 'entry' : 'entries'}`
    : '';

  return <>
    <strong>{EXPORT_STATE_LABELS[job.state]}</strong>
    <span className="export-state__prepared">
      Prepared {prepared.dateTime === null
        ? prepared.value
        : <time dateTime={prepared.dateTime}>{prepared.value}</time>}
      {' · '}{photoCount(job.mediaCount)}{' · '}{EXPORT_STATE_LABELS[job.state]}
    </span>
    <span>Frozen size: {formatBytes(job.totalBytes)}{guestbook}.</span>
    <span>{stateMessage}</span>
    {progress === null ? null : <span>{progress}</span>}
    {isTerminalExport(job)
      ? <span>{describeCurrentSource(currentSource, job.mediaCount, currentLabel)}</span>
      : null}
  </>;
}

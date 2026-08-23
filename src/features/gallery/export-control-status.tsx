import { useEffect, type ReactElement } from 'react';

import type { ExportView } from '../../app/types';

/** Exhaustive visible and announced labels shared by both export surfaces. */
export const EXPORT_STATE_LABELS: Record<ExportView['state'], string> = {
  queued: 'Preparing',
  running: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

/**
 * One persistent status node that either announces directly or forwards into
 * Gallery's single live host when the control is nested inside the workspace.
 */
export function ExportStatusAnnouncement({
  live,
  message,
  onAnnouncement,
}: {
  live: boolean;
  message: string;
  onAnnouncement?(message: string): void;
}): ReactElement {
  useEffect(() => {
    if (!live && message) onAnnouncement?.(message);
  }, [live, message, onAnnouncement]);

  return <p
    className="sr-only"
    role={live ? 'status' : undefined}
    aria-live={live ? 'polite' : undefined}
    aria-atomic={live ? 'true' : undefined}
  >{message}</p>;
}

import { useEffect, useId, useRef, useState } from 'react';

import type { AlbumLeavePreparation } from '../features/gallery/ManagerAlbum';
import type { DomainAutosaveState } from '../features/settings/autosave-queue';

interface UnsavedSettingsPromptProps {
  domains: readonly DomainAutosaveState[];
  onLeave(): void;
  leaveDisabled?: boolean;
  // Offered only when staying would achieve something: a draft that cannot be
  // sent, or a save that failed. A request merely in flight has nothing to fix.
  onStay?(): void;
  albumOutcome?: AlbumLeavePreparation | null;
  onRetryAlbum?(): void;
  onDiscardAlbum?(): void;
  focusKey?: string;
}

export function UnsavedSettingsPrompt({
  domains,
  onLeave,
  leaveDisabled = false,
  onStay,
  albumOutcome = null,
  onRetryAlbum,
  onDiscardAlbum,
  focusKey,
}: UnsavedSettingsPromptProps) {
  const container = useRef<HTMLDivElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const progressId = `${id}-progress`;
  const retryRequested = useRef(false);
  const [retryPending, setRetryPending] = useState(false);
  // The host asked to navigate, so this answers their own action and focus
  // belongs on it. Background save errors never move focus.
  useEffect(() => { container.current?.focus(); }, [focusKey]);
  const albumPrompt = albumOutcome !== null;
  const waitingForAlbum = albumOutcome?.status === 'waiting';
  useEffect(() => {
    if (waitingForAlbum || !retryRequested.current) return;
    retryRequested.current = false;
    setRetryPending(false);
  }, [waitingForAlbum]);
  const names = domains.map((domain) => domain.label).join(' and ');
  const leaveIsDisabled = leaveDisabled || waitingForAlbum;
  const describedBy = leaveIsDisabled ? `${bodyId} ${progressId}` : bodyId;
  const showAlbumRetry = albumOutcome?.status === 'invalid'
    || albumOutcome?.status === 'failed'
    || retryPending;
  return <div
    className="unsaved-settings-prompt"
    role="region"
    aria-labelledby={titleId}
    aria-describedby={describedBy}
    tabIndex={-1}
    ref={container}
  >
    <h2 id={titleId}>
      {albumPrompt
        ? 'Album changes are not saved yet'
        : <>{names || 'Your settings'} {domains.length > 1 ? 'are' : 'is'} not saved yet</>}
    </h2>
    {/* Honest about what leaving can and cannot undo: a request already sent may
        still commit, and no button here can recall it. */}
    <p id={bodyId}>
      A change already sent may still finish saving after you leave. Leaving now discards anything
      that has not been sent.
    </p>
    {leaveIsDisabled && <p id={progressId} role="status">
      Finishing Album checks before Leave now is available.
    </p>}
    {albumOutcome?.status === 'invalid' && <p role="status">
      {albumOutcome.field} needs attention before the Album can be confirmed.
    </p>}
    {albumOutcome?.status === 'failed' && <p role="alert">{albumOutcome.message}</p>}
    <div className="button-row">
      {albumPrompt
        ? <>
            {showAlbumRetry && <button
              type="button"
              className="button button--primary"
              aria-disabled={retryPending || undefined}
              aria-busy={retryPending || undefined}
              aria-describedby={retryPending ? progressId : undefined}
              onClick={() => {
                if (retryRequested.current || waitingForAlbum || !onRetryAlbum) return;
                retryRequested.current = true;
                setRetryPending(true);
                onRetryAlbum();
              }}
            >{retryPending ? 'Retrying Album…' : 'Retry'}</button>}
            {onStay && <button type="button" className="button button--secondary" onClick={onStay}>
              Stay in Album
            </button>}
            <button
              type="button"
              className="button button--secondary"
              disabled={waitingForAlbum}
              aria-describedby={waitingForAlbum ? progressId : undefined}
              onClick={onDiscardAlbum ?? onLeave}
            >Discard unsent Album changes and leave</button>
          </>
        : <>
            <button
              type="button"
              className="button button--secondary"
              disabled={leaveIsDisabled}
              aria-describedby={leaveIsDisabled ? progressId : undefined}
              onClick={onLeave}
            >Leave now</button>
            {onStay && <button type="button" className="button button--primary" onClick={onStay}>
              Stay and fix settings
            </button>}
          </>}
    </div>
  </div>;
}

import { useEffect, useState } from 'react';

import type { EventCoverPreparationView } from '../../shared/event-cover';
import type { CoverOperationReconciler } from '../features/cover/use-cover-operation-reconciler';

interface ManagerCoverPreparationStatusProps {
  /** The Manager-level owner; this component performs no reads or scheduling. */
  reconciler: CoverOperationReconciler;
}

function isUnresolved(view: EventCoverPreparationView | null): boolean {
  return view?.status === 'preparing' || (view?.status === 'retryable-failed' && view.retryable);
}

export function ManagerCoverPreparationStatus({
  reconciler,
}: ManagerCoverPreparationStatusProps) {
  const live = reconciler.operation;
  const [retrying, setRetrying] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [live?.operationId, live?.status]);

  if (!live || dismissed) return null;

  if (live.status === 'preparing') {
    return <p className="cover-preparation" role="status">
      {reconciler.operationState.slow
        ? 'Still preparing. Your current cover is safe, and you can close this window.'
        : `Preparing cover ${Math.min(live.completedSteps + 1, live.requiredSteps)} of ${live.requiredSteps}. Your current cover is still live.`}
    </p>;
  }

  if (live.status === 'applied') {
    return <p className="cover-preparation cover-preparation--success" role="status">
      Your new cover is live.
    </p>;
  }

  if (live.status === 'conflict') {
    return <p className="cover-preparation cover-preparation--warning" role="status">
      This cover changed somewhere else, so that change was not applied. Reload to see the current cover.
    </p>;
  }

  const retryable = live.status === 'retryable-failed' && live.retryable;
  return <div className="cover-preparation cover-preparation--warning" role="status">
    <p>{retryable
      ? 'That cover could not be prepared. Your current cover is still live.'
      : 'That cover could not be prepared. Your current cover is still live — choose the photo again.'}</p>
    {retryable
      ? <button
          type="button"
          className="button button--secondary"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void reconciler.retry().finally(() => setRetrying(false));
          }}
        >
          {retrying ? 'Trying…' : 'Try again'}
        </button>
      : <button
          type="button"
          className="button button--secondary"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>}
  </div>;
}

export { isUnresolved as isUnresolvedCoverPreparation };

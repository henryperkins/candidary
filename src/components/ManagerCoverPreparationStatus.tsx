import { useCallback, useEffect, useRef, useState } from 'react';

import type { EventCoverPreparationView } from '../../shared/event-cover';
import { readCoverOperation, restartCoverOperation, forgetCoverOperation } from '../features/cover/cover-draft-client';

/**
 * Reconciliation that does not depend on a sheet being open.
 *
 * The Manager event read carries the event's one unresolved or actionable
 * receipt, so this resumes on load, on network recovery, and after a reload
 * with every scrap of local state cleared. Progress copy comes from durable
 * step counts — never from elapsed time — and never says "profile", which is an
 * implementation word.
 */

interface ManagerCoverPreparationStatusProps {
  eventId: string;
  preparation: EventCoverPreparationView | null;
  /** A fresh Manager event read, so an applied outcome updates the canvas. */
  onResolved(): void;
}

// 2, 4, 8, then at most 10 seconds between responses.
const POLL_STEPS = [2_000, 4_000, 8_000, 10_000];
const STILL_PREPARING_AFTER_MS = 60_000;

function isUnresolved(view: EventCoverPreparationView | null): boolean {
  return view?.status === 'preparing' || (view?.status === 'retryable-failed' && view.retryable);
}

export function ManagerCoverPreparationStatus({
  eventId,
  preparation,
  onResolved,
}: ManagerCoverPreparationStatusProps) {
  const [live, setLive] = useState<EventCoverPreparationView | null>(preparation);
  const [slow, setSlow] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const resolvedRef = useRef(onResolved);
  resolvedRef.current = onResolved;
  const settledRef = useRef<string | null>(null);

  useEffect(() => {
    setLive(preparation);
    setDismissed(false);
  }, [preparation]);

  /**
   * Releases a terminal operation however it was observed.
   *
   * The poll below only runs while a receipt is `preparing`, so a reload during
   * preparation lands on an already-terminal receipt and no poll ever runs. The
   * operation key would then outlive its receipt, and the next cover change
   * would reuse that ID with different bytes — a `409` no host action caused,
   * for as long as the tab stays open. A retryable failure is deliberately not
   * released, because the same operation is what restarts.
   */
  useEffect(() => {
    const view = live;
    if (!view || view.status === 'preparing') return;
    if (view.status === 'retryable-failed' && view.retryable) return;
    if (settledRef.current === view.operationId) return;
    settledRef.current = view.operationId;
    forgetCoverOperation(eventId);
    // A permanent failure changed nothing on the event, so it needs no read.
    if (view.status === 'applied' || view.status === 'conflict') resolvedRef.current();
  }, [eventId, live]);

  const operationId = live?.operationId ?? null;
  const status = live?.status ?? null;

  // Elapsed time changes the copy and nothing else. It never becomes failure,
  // and it never stands in for a step count.
  useEffect(() => {
    if (status !== 'preparing') {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), STILL_PREPARING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [status, operationId]);

  useEffect(() => {
    if (!operationId || status !== 'preparing') return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    async function poll() {
      if (stopped) return;
      // Paused while the document is hidden, resumed on visibility.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(() => void poll(), POLL_STEPS[POLL_STEPS.length - 1]);
        return;
      }
      try {
        const next = await readCoverOperation(eventId, operationId!);
        if (stopped) return;
        if (next) {
          setLive(next);
          // Terminal outcomes are released by the effect above, which is the
          // one place that decides, whether the answer arrived by poll or was
          // already on the event view at mount.
          if (next.status !== 'preparing') return;
        }
      } catch {
        /* A lost poll is not a failure. The next one carries the same answer. */
      }
      const delay = POLL_STEPS[Math.min(attempt, POLL_STEPS.length - 1)]!;
      attempt += 1;
      timer = setTimeout(() => void poll(), delay);
    }

    timer = setTimeout(() => void poll(), POLL_STEPS[0]);
    const resume = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        attempt = 0;
        timer = setTimeout(() => void poll(), 0);
      }
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [eventId, operationId, status]);

  const retry = useCallback(async () => {
    if (!operationId || retrying) return;
    setRetrying(true);
    try {
      // Only the operation ID travels. The draft, recipe, expected revision, and
      // Workflow instance are all pinned on the receipt, which is what lets this
      // work after a reload that cleared everything local.
      const next = await restartCoverOperation(eventId, operationId);
      if (next) setLive(next);
    } catch {
      /* The receipt still stands; the status below explains what to do. */
    } finally {
      setRetrying(false);
    }
  }, [eventId, operationId, retrying]);

  if (!live || dismissed) return null;

  if (live.status === 'preparing') {
    return <p className="cover-preparation" role="status">
      {slow
        ? 'Still preparing. Your current cover is safe, and you can close this window.'
        : `Preparing cover ${Math.min(live.completedSteps + 1, live.requiredSteps)} of ${live.requiredSteps}. Your current cover is still live.`}
    </p>;
  }

  if (live.status === 'applied') {
    return <p className="cover-preparation" role="status">Your new cover is live.</p>;
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
      ? <button type="button" className="button button--secondary" disabled={retrying} onClick={() => void retry()}>
        {retrying ? 'Trying…' : 'Try again'}
      </button>
      : <button type="button" className="button button--secondary" onClick={() => setDismissed(true)}>
        Dismiss
      </button>}
  </div>;
}

export { isUnresolved as isUnresolvedCoverPreparation };

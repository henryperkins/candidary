import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryArrivalSummary, LibraryQuery } from '../../../shared/library-arrivals';
import { api } from '../../app/api';
import { describeLoadFailure, type LoadFailure } from '../../components/States';

export function useLibraryArrivals(options: LibraryQuery & {
  eventId: string;
  snapshotSequence: number | null;
  active: boolean;
  paused: boolean;
  onEscalate?(failure: LoadFailure): void;
}): { count: number; latestSnapshotSequence: number | null; checkNow(): Promise<void> } {
  const { eventId, query, favorites, order, snapshotSequence, active, paused } = options;
  const key = JSON.stringify([eventId, query, favorites, order, snapshotSequence]);
  const [summary, setSummary] = useState<{ key: string; count: number; sequence: number | null }>({ key, count: 0, sequence: null });
  const owner = useRef(key); owner.current = key;
  const currentOptions = useRef(options); currentOptions.current = options;
  const blockedOwner = useRef<string | null>(null);
  const check = useRef<() => Promise<void>>(async () => {});
  const checkNow = useCallback(() => check.current(), []);
  useEffect(() => {
    let retired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let request: Promise<void> | null = null;
    const enabled = () => !retired && active && !paused && snapshotSequence !== null
      && document.visibilityState === 'visible' && blockedOwner.current !== eventId;
    const run = (): Promise<void> => {
      if (!enabled()) return Promise.resolve();
      if (request) return request;
      clearTimeout(timer);
      const ownedController = new AbortController(); controller = ownedController;
      const params = new URLSearchParams({ after: String(snapshotSequence), order });
      if (query) params.set('query', query);
      if (favorites) params.set('favorites', '1');
      const ownedRequest = (async () => {
        try {
          const result = await api<LibraryArrivalSummary>(`/api/manage/events/${eventId}/gallery/arrivals?${params}`, { signal: ownedController.signal });
          if (retired || ownedController.signal.aborted || owner.current !== key) return;
          setSummary({ key, count: result.count, sequence: result.snapshotSequence });
        } catch (caught) {
          if (retired || ownedController.signal.aborted || owner.current !== key) return;
          const failure = describeLoadFailure(caught, 'manager', 'New photos could not be checked.');
          if (!failure.retryable) {
            blockedOwner.current = eventId;
            currentOptions.current.onEscalate?.(failure);
          }
        } finally {
          if (controller === ownedController) {
            controller = null; request = null;
            if (enabled()) timer = setTimeout(() => { void run(); }, 5000);
          }
        }
      })();
      request = ownedRequest;
      return ownedRequest;
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.visibilityState !== 'visible') { controller?.abort(); controller = null; request = null; }
      else void run();
    };
    check.current = run;
    document.addEventListener('visibilitychange', visibility);
    void run();
    return () => {
      retired = true; clearTimeout(timer); controller?.abort();
      document.removeEventListener('visibilitychange', visibility);
      if (check.current === run) check.current = async () => {};
    };
  }, [key, eventId, query, favorites, order, snapshotSequence, active, paused]);
  return { count: summary.key === key ? summary.count : 0,
    latestSnapshotSequence: summary.key === key ? summary.sequence : null, checkNow };
}

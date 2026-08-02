import { useEffect, useRef } from 'react';

export type LifecycleRecheckOutcome = 'changed' | 'unchanged';

/**
 * A single armed timer per boundary is capped at roughly this, then re-armed
 * with whatever is left. `setTimeout` truncates anything past 2^31−1 ms to a
 * fire-immediately, and a long-lived tab left open across a week-away start
 * would otherwise spin instead of sleeping.
 */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

/**
 * The anti-spin floor. It applies only *after* a recheck that returned an
 * unchanged view or failed — never to the initial boundary delay, which has to
 * fire on time or the page misses its own transition.
 */
const RECHECK_FLOOR_MS = 30 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Moves a guest or manager page across a server-decided lifecycle boundary
 * without ever consulting the browser's clock.
 *
 * `delayMs` is a *relative* delay the server computed from the same instant
 * that resolved the view it sent. Comparing an absolute boundary against
 * `Date.now()` would make a device whose clock runs fast switch early and one
 * running slow switch hours late; a relative delay removes the browser clock
 * from the decision entirely.
 *
 * The timer only triggers a refetch. The server remains authoritative about
 * whether anything actually changed — `onRecheck` reports that back so a view
 * that has not moved cannot become a spin.
 *
 * A failed background refresh keeps the current surface on screen. It never
 * replaces a working page with an error; it retries with bounded backoff.
 */
export function useLifecycleRecheck(
  delayMs: number | null,
  onRecheck: () => Promise<LifecycleRecheckOutcome>,
  lifecycleKey: string | null = null,
): void {
  // Everything the timer continuation reads has to be readable synchronously
  // from a promise callback, and the callback identity changes every render.
  const recheckRef = useRef(onRecheck);
  recheckRef.current = onRecheck;

  useEffect(() => {
    if (delayMs === null) return;

    let disposed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let boundaryPending = false;
    let backoffMs = RECHECK_FLOOR_MS;
    // The earliest moment a *repeat* attempt is allowed. Measured with elapsed
    // time from the same origin as the timer itself, never against a wall
    // clock, so a device whose clock is wrong is still only ever early or late
    // by its own scheduler drift.
    let floorUntil = 0;
    const elapsed = () => (
      typeof performance === 'undefined' ? 0 : performance.now()
    );

    function schedule(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
      return timer;
    }

    function clearRetry(): void {
      if (retryTimer === undefined) return;
      clearTimeout(retryTimer);
      timers.delete(retryTimer);
      retryTimer = undefined;
    }

    function clearTimers(): void {
      for (const active of timers) clearTimeout(active);
      timers.clear();
      retryTimer = undefined;
    }

    function armBoundary(remainingMs: number): void {
      if (disposed) return;
      const slice = Math.min(Math.max(remainingMs, 0), MAX_TIMER_MS);
      schedule(() => {
        const left = remainingMs - slice;
        // Re-armed rather than fired: a boundary further out than one timer
        // slice keeps sleeping instead of waking the page for nothing.
        if (left > 0) {
          armBoundary(left);
          return;
        }
        void run('boundary');
      }, slice);
    }

    function armRetry(delay: number): void {
      if (disposed) return;
      clearRetry();
      retryTimer = schedule(() => {
        retryTimer = undefined;
        void run('retry');
      }, Math.max(delay, 0));
    }

    function deferRetry(): void {
      floorUntil = elapsed() + backoffMs;
      armRetry(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }

    async function run(source: 'boundary' | 'wake' | 'retry'): Promise<void> {
      if (disposed) return;
      if (running) {
        // A wake may be dropped while another read is already current, but the
        // one server-supplied boundary must survive a just-before-boundary read.
        if (source === 'boundary') boundaryPending = true;
        return;
      }
      const remainingFloor = floorUntil - elapsed();
      if (source !== 'boundary' && remainingFloor > 0) {
        // A retry timer can fire a fraction early through scheduler rounding;
        // preserve it for the remaining elapsed-time floor instead of losing it.
        if (source === 'retry') armRetry(remainingFloor);
        return;
      }
      running = true;
      try {
        const outcome = await recheckRef.current();
        if (disposed) return;
        if (outcome === 'changed') {
          // A changed view arrives with its own delay and semantic key. The key
          // reruns this effect even when the replacement delay happens to be
          // numerically equal. Retire the old timers immediately rather than
          // leaving a gap before React commits the replacement.
          boundaryPending = false;
          clearTimers();
          return;
        }
        deferRetry();
      } catch {
        if (disposed) return;
        deferRetry();
      } finally {
        running = false;
        if (boundaryPending && !disposed) {
          boundaryPending = false;
          void run('boundary');
        }
      }
    }

    function wake(): void {
      // A tab restored from the back/forward cache, or a phone unlocked at the
      // venue, has usually slept straight through its own boundary. The floor
      // is what keeps a flapping connection from turning this into a poll.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void run('wake');
    }

    armBoundary(delayMs);
    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('pageshow', wake);
      window.addEventListener('online', wake);
    }

    return () => {
      disposed = true;
      clearTimers();
      if (typeof window !== 'undefined') {
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('pageshow', wake);
        window.removeEventListener('online', wake);
      }
    };
  }, [delayMs, lifecycleKey]);
}

import { useEffect, useState } from 'react';

// Browsers coerce longer delays through a signed 32-bit timer. Re-check rather
// than letting a multi-week deadline fire immediately or wrap around.
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Re-renders at the nearest future deadline.
 *
 * Deadlines are absolute server instants, so consumers compare the returned
 * clock with their own value rather than maintaining a parallel countdown.
 */
export function useDeadlineClock(deadlines: readonly string[]): number {
  const [now, setNow] = useState(() => Date.now());
  const deadlineKey = deadlines.join('|');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const values = deadlineKey === '' ? [] : deadlineKey.split('|');
    const schedule = () => {
      if (stopped) return;
      const wallNow = Date.now();
      setNow(wallNow);
      const nearest = values.reduce<number | null>((current, deadline) => {
        const value = Date.parse(deadline);
        if (!Number.isFinite(value) || value <= wallNow) return current;
        return current === null || value < current ? value : current;
      }, null);
      if (nearest === null) return;
      timer = setTimeout(schedule, Math.min(nearest - wallNow, MAX_TIMEOUT_MS));
    };
    schedule();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [deadlineKey]);

  return now;
}

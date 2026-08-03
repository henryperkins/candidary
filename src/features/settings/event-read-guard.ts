/**
 * Whole-event reads and manager writes race. The five-second intake poll can be
 * open when an autosave commits, and its answer — assembled before the write —
 * would arrive afterward and put the row back. Ownership merges cannot help
 * here: a GET legitimately owns every field, it is just answering for a row
 * that has moved.
 *
 * So a read is adopted only if nothing wrote while it was open. An epoch moves
 * on the way into and out of every write, and a read that sees a different
 * number than it started with is answering for a version of the row that no
 * longer exists. Dropping a read that would have been fine costs one poll
 * interval; adopting a stale one silently rewrites the host's settings.
 *
 * A required reconciliation read cannot simply wait for the next poll. It also
 * tracks active writes, waits for all of them to settle before starting, and
 * waits again before retrying if a new write overlapped its request.
 */
export interface EventReadGuard {
  beginWrite(): void;
  endWrite(): void;
  openRead(): number;
  adopt(token: number): boolean;
  readFresh<T>(request: () => Promise<T>): Promise<T>;
}

export function createEventReadGuard(): EventReadGuard {
  let epoch = 0;
  let activeWrites = 0;
  let idlePromise: Promise<void> | null = null;
  let resolveIdle: (() => void) | null = null;
  const move = () => { epoch += 1; };
  const openRead = () => epoch;
  const adopt = (token: number) => token === epoch;

  const waitForIdle = (): Promise<void> => {
    if (activeWrites === 0) return Promise.resolve();
    if (idlePromise === null) {
      idlePromise = new Promise<void>((resolve) => { resolveIdle = resolve; });
    }
    return idlePromise;
  };

  const beginWrite = () => {
    activeWrites += 1;
    move();
  };

  const endWrite = () => {
    move();
    activeWrites -= 1;
    if (activeWrites === 0) {
      const resolve = resolveIdle;
      idlePromise = null;
      resolveIdle = null;
      resolve?.();
    }
  };

  return {
    beginWrite,
    endWrite,
    openRead,
    adopt,
    async readFresh<T>(request: () => Promise<T>): Promise<T> {
      // A conflict-recovery read has to return a usable current row, unlike a
      // poll that can simply be dropped until the next interval. Wait for all
      // existing writes, then retry only a read that another write proved
      // stale. Recheck after waking because a new write may have started in
      // the same microtask turn that resolved the idle promise.
      for (;;) {
        await waitForIdle();
        if (activeWrites !== 0) continue;
        const token = openRead();
        const result = await request();
        if (adopt(token)) return result;
      }
    },
  };
}

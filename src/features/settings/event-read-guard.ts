/**
 * Whole-event reads and manager writes race. The five-second intake poll can be
 * open when an autosave commits, and its answer — assembled before the write —
 * would arrive afterward and put the row back. Ownership merges cannot help
 * here: a GET legitimately owns every field, it is just answering for a row
 * that has moved.
 *
 * So a read is adopted only if nothing wrote while it was open. One counter is
 * enough: a write moves it on the way in and on the way out, and a read that
 * sees a different number than it started with is answering for a version of
 * the row that no longer exists. Dropping a read that would have been fine
 * costs one poll interval; adopting a stale one silently rewrites the host's
 * settings.
 */
export interface EventReadGuard {
  beginWrite(): void;
  endWrite(): void;
  openRead(): number;
  adopt(token: number): boolean;
}

export function createEventReadGuard(): EventReadGuard {
  let epoch = 0;
  const move = () => { epoch += 1; };
  return {
    beginWrite: move,
    endWrite: move,
    openRead: () => epoch,
    adopt: (token) => token === epoch,
  };
}

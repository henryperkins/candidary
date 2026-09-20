import { MAX_EVENT_MEDIA, type GalleryTimelineOrder } from '../../../shared/constants';
import type { LibraryPage } from '../../../shared/library-arrivals';

export interface LibraryTimelineKey { timelineAt: string; id: string }
export interface LibraryArrivalExpectation { afterSequence: number; count: number }
export type FetchLibraryPage = (request: {
  snapshotSequence: number; cursor?: string; signal: AbortSignal;
}) => Promise<LibraryPage>;

export function compareLibraryKeys(a: LibraryTimelineKey, b: LibraryTimelineKey, order: GalleryTimelineOrder): number {
  const direction = order === 'earliest' ? 1 : -1;
  const raw = a.timelineAt === b.timelineAt
    ? (a.id === b.id ? 0 : a.id < b.id ? -1 : 1)
    : a.timelineAt < b.timelineAt ? -1 : 1;
  return direction * raw;
}

/** Stage a bounded loaded window; no caller-visible rows change before this resolves. */
export async function readLibraryWindow(request: {
  fetchPage: FetchLibraryPage;
  snapshotSequence: number;
  boundary: LibraryTimelineKey | null;
  order: GalleryTimelineOrder;
  signal: AbortSignal;
  arrivals?: LibraryArrivalExpectation;
}): Promise<LibraryPage> {
  const { fetchPage, snapshotSequence, boundary, order, signal, arrivals } = request;
  const media: LibraryPage['media'] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let incorporatedArrivals = 0;
  for (;;) {
    signal.throwIfAborted();
    const page = await fetchPage({ snapshotSequence, ...(cursor ? { cursor } : {}), signal });
    signal.throwIfAborted();
    if (page.snapshotSequence !== snapshotSequence) throw new Error('Library snapshot changed during refresh.');
    for (const photo of page.media) {
      if (seenIds.has(photo.id)) continue;
      if (media.length >= MAX_EVENT_MEDIA) throw new Error('Library exceeds the event photo limit.');
      seenIds.add(photo.id); media.push(photo);
      if (arrivals && photo.deliverySequence > arrivals.afterSequence && photo.deliverySequence <= snapshotSequence) {
        incorporatedArrivals++;
      }
    }
    if (page.nextCursor !== null && seenCursors.has(page.nextCursor)) throw new Error('Repeated Library continuation cursor.');
    const last = page.media.at(-1);
    const reachedBoundary = boundary === null || (last && compareLibraryKeys(last, boundary, order) >= 0);
    const reachedArrivals = !arrivals || incorporatedArrivals >= arrivals.count;
    if (page.nextCursor === null || (reachedBoundary && reachedArrivals)) {
      return { media, nextCursor: page.nextCursor, snapshotSequence };
    }
    if (!last || media.length >= MAX_EVENT_MEDIA) throw new Error('Library continuation did not reach the loaded boundary.');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

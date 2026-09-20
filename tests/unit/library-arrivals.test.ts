import { describe, expect, it, vi } from 'vitest';
import { compareLibraryKeys, readLibraryWindow, type FetchLibraryPage } from '../../src/features/gallery/library-arrivals';
import type { LibraryMediaView } from '../../shared/library-arrivals';
const row = (id: string, timelineAt = '2026-09-19T10:00:00.000Z'): LibraryMediaView => ({ id, deliverySequence: 1, timelineAt, timelineSource: 'received', receivedAt: timelineAt, originalFilename: `${id}.jpg`, guestName: 'Guest', caption: null, publicationStatus: 'unpublished', previewAvailable: true, width: null, height: null, isFavorite: false });
describe('Library loaded window', () => {
  it('orders equal-timestamp keys deterministically in both directions', () => {
    expect(compareLibraryKeys(row('a'), row('b'), 'earliest')).toBeLessThan(0);
    expect(compareLibraryKeys(row('a'), row('b'), 'newest')).toBeGreaterThan(0);
  });
  it.each(['earliest', 'newest'] as const)('stops at the old boundary in %s order and deduplicates IDs', async order => {
    const ids = order === 'earliest' ? ['a', 'b', 'c'] : ['c', 'b', 'a'];
    const fetchPage = vi.fn<FetchLibraryPage>()
      .mockResolvedValueOnce({media:[row(ids[0]!),row(ids[1]!)],nextCursor:'two',snapshotSequence:8})
      .mockResolvedValueOnce({media:[row(ids[1]!),row(ids[2]!)],nextCursor:'three',snapshotSequence:8});
    const result = await readLibraryWindow({ fetchPage, snapshotSequence:8, boundary:row(ids[2]!), order, signal:new AbortController().signal });
    expect(result.media.map(photo => photo.id)).toEqual(ids);
    expect(result.nextCursor).toBe('three'); expect(fetchPage).toHaveBeenCalledTimes(2);
  });
  it('requests one page for an empty starting collection', async () => {
    const fetchPage = vi.fn<FetchLibraryPage>().mockResolvedValue({media:[row('a')],nextCursor:'two',snapshotSequence:8});
    await readLibraryWindow({fetchPage,snapshotSequence:8,boundary:null,order:'newest',signal:new AbortController().signal});
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it.each(['earliest', 'newest'] as const)('incorporates counted deliveries beyond the old boundary in %s order', async order => {
    const ids = order === 'earliest' ? ['a', 'b', 'c'] : ['c', 'b', 'a'];
    const old = { ...row(ids[0]!), deliverySequence: 5 };
    const arrived = { ...row(ids[1]!), deliverySequence: 6 };
    const fetchPage = vi.fn<FetchLibraryPage>()
      .mockResolvedValueOnce({ media: [old], nextCursor: 'two', snapshotSequence: 6 })
      .mockResolvedValueOnce({ media: [arrived], nextCursor: 'three', snapshotSequence: 6 });
    const result = await readLibraryWindow({ fetchPage, snapshotSequence: 6, boundary: old,
      order, signal: new AbortController().signal, arrivals: { afterSequence: 5, count: 1 } });
    expect(result.media.map(photo => photo.id)).toEqual(ids.slice(0, 2));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.nextCursor).toBe('three');
  });
  it.each(['earliest', 'newest'] as const)('paginates a 49-arrival burst from an empty %s collection', async order => {
    const photos = Array.from({ length: 49 }, (_, index) => ({
      ...row(String(index).padStart(2, '0')), deliverySequence: index + 1,
    }));
    if (order === 'newest') photos.reverse();
    const fetchPage = vi.fn<FetchLibraryPage>()
      .mockResolvedValueOnce({ media: photos.slice(0, 48), nextCursor: 'two', snapshotSequence: 49 })
      .mockResolvedValueOnce({ media: photos.slice(48), nextCursor: null, snapshotSequence: 49 });
    const result = await readLibraryWindow({ fetchPage, snapshotSequence: 49, boundary: null,
      order, signal: new AbortController().signal, arrivals: { afterSequence: 0, count: 49 } });
    expect(result.media).toHaveLength(49);
    expect(result.media.at(-1)?.id).toBe(order === 'earliest' ? '48' : '00');
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.nextCursor).toBeNull();
  });
  it('deduplicates counted deliveries and exhausts the snapshot when a counted arrival disappears', async () => {
    const old = { ...row('a'), deliverySequence: 5 };
    const arrived = { ...row('b'), deliverySequence: 6 };
    const fetchPage = vi.fn<FetchLibraryPage>()
      .mockResolvedValueOnce({ media: [old, arrived], nextCursor: 'two', snapshotSequence: 7 })
      .mockResolvedValueOnce({ media: [arrived], nextCursor: 'three', snapshotSequence: 7 })
      .mockResolvedValueOnce({ media: [], nextCursor: null, snapshotSequence: 7 });
    const result = await readLibraryWindow({ fetchPage, snapshotSequence: 7, boundary: old,
      order: 'earliest', signal: new AbortController().signal, arrivals: { afterSequence: 5, count: 2 } });
    expect(result.media.map(photo => photo.id)).toEqual(['a', 'b']);
    expect(result.nextCursor).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
  it('rejects repeated cursors and cancelled work', async () => {
    const fetchPage = vi.fn<FetchLibraryPage>().mockResolvedValue({media:[row('a')],nextCursor:'same',snapshotSequence:8});
    await expect(readLibraryWindow({fetchPage,snapshotSequence:8,boundary:row('z'),order:'earliest',signal:new AbortController().signal})).rejects.toThrow(/cursor/i);
    const controller = new AbortController(); controller.abort();
    await expect(readLibraryWindow({fetchPage,snapshotSequence:8,boundary:null,order:'newest',signal:controller.signal})).rejects.toThrow();
  });
});

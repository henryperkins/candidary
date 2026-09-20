import { describe, expect, it, vi } from 'vitest';
import { compareLibraryKeys, readLibraryWindow, type FetchLibraryPage } from '../../src/features/gallery/library-arrivals';
import type { ManagerGalleryMediaView } from '../../shared/contracts';
const row = (id: string, timelineAt = '2026-09-19T10:00:00.000Z') => ({ id, timelineAt, receivedAt: timelineAt, originalFilename: `${id}.jpg`, guestName: 'Guest', caption: null, publicationStatus: 'unpublished', previewAvailable: true, width: null, height: null, isFavorite: false } as ManagerGalleryMediaView);
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
  it('rejects repeated cursors and cancelled work', async () => {
    const fetchPage = vi.fn<FetchLibraryPage>().mockResolvedValue({media:[row('a')],nextCursor:'same',snapshotSequence:8});
    await expect(readLibraryWindow({fetchPage,snapshotSequence:8,boundary:row('z'),order:'earliest',signal:new AbortController().signal})).rejects.toThrow(/cursor/i);
    const controller = new AbortController(); controller.abort();
    await expect(readLibraryWindow({fetchPage,snapshotSequence:8,boundary:null,order:'newest',signal:controller.signal})).rejects.toThrow();
  });
});

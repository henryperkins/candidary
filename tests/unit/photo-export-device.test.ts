import { describe, expect, it, vi } from 'vitest';
import type { PhotoExportEntryView } from '../../shared/photo-exports';
import { prepareDeviceBatch } from '../../src/features/gallery/photo-export-device';
const entry = (id: string, byteSize = 2): PhotoExportEntryView => ({ mediaId: id, position: 1, filename: `${id}.jpg`, mimeType: 'image/jpeg', byteSize, state: 'pending' });
describe('photo export device batches', () => {
  it('returns actual originals and bounds count, bytes and concurrency', async () => {
    let active = 0; let peak = 0;
    const read = vi.fn(async (item: PhotoExportEntryView) => {
      active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
      return new File(['ab'], item.filename, { type: item.mimeType });
    });
    const batch = await prepareDeviceBatch(Array.from({ length: 25 }, (_, i) => entry(`${i}`)), read, new AbortController().signal);
    expect(batch.files).toHaveLength(20);
    expect(batch.files.every(file => file instanceof File)).toBe(true);
    expect(read).toHaveBeenCalledTimes(20); expect(peak).toBeLessThanOrEqual(2);
  });
  it('retains failures and rejects changed MIME/length without silently converting', async () => {
    const batch = await prepareDeviceBatch([entry('large', 50 * 1024 * 1024), entry('bad'), entry('ok')], async item => new File(['ab'], item.filename, { type: item.mediaId === 'bad' ? 'text/plain' : 'image/jpeg' }), new AbortController().signal);
    expect(batch.preparedIds).toEqual(['ok']); expect(batch.failedIds).toEqual(['large', 'bad']);
  });
  it('retires aborted work instead of publishing a late batch', async () => {
    const abort = new AbortController();
    await expect(prepareDeviceBatch([entry('a')], async item => { abort.abort(); return new File(['ab'], item.filename, { type: item.mimeType }); }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

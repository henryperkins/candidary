import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildExportManifest, buildMediaCsv } from '../../worker/export/csv';
import { partitionExportSnapshot } from '../../worker/export/partition';
import { buildExportZip, buildExportZipStream, exportPath } from '../../worker/export/zip-stream';

const media = {
  id: 'media-a', eventId: 'event-a', uploaderSessionId: 'session-a',
  objectKey: 'events/event-a/media/a', originalFilename: 'Maya, "laughing".png',
  mimeType: 'image/png' as const, declaredByteSize: 64, byteSize: 64,
  width: 800, height: 600, guestName: 'Zoë', caption: 'A bright, "golden" hour',
  uploadState: 'stored' as const, publicationStatus: 'published' as const,
  idempotencyKey: 'upload-a', reservationExpiresAt: '2026-07-21T12:15:00.000Z',
  createdAt: '2026-07-21T12:00:00.000Z', publishedAt: '2026-07-21T12:05:00.000Z', previewObjectKey: null,
  deletedAt: null,
};

describe('export metadata', () => {
  it('escapes CSV values and emits stable columns', () => {
    const csv = buildMediaCsv([media]);
    expect(csv).toContain('media_id,original_filename,guest_name,caption,mime_type,byte_size,width,height,uploaded_at,publication_status,published_at');
    expect(csv).toContain('"Maya, ""laughing"".png"');
    expect(csv).toContain('"A bright, ""golden"" hour"');
    expect(csv).toContain('Zoë');
  });

  it('builds deterministic collision-safe paths', () => {
    expect(exportPath(media, 0)).toBe('photos/001-maya-laughing.png');
    expect(exportPath({ ...media, id: 'media-b' }, 1)).toBe('photos/002-maya-laughing.png');
  });

  it('creates a readable archive with originals and media.csv', () => {
    const archive = unzipSync(buildExportZip([
      { media, bytes: new Uint8Array([1, 2, 3]) },
      { media: { ...media, id: 'media-b' }, bytes: new Uint8Array([4, 5]) },
    ]));
    expect(Object.keys(archive)).toEqual([
      'photos/001-maya-laughing.png',
      'photos/002-maya-laughing.png',
      'media.csv',
    ]);
    expect([...archive['photos/001-maya-laughing.png']!]).toEqual([1, 2, 3]);
    expect(strFromU8(archive['media.csv']!)).toContain('media-a');
  });

  it('streams the same readable archive without buffering source objects', async () => {
    const stream = buildExportZipStream([
      { media, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([7, 8, 9])); controller.close(); } }) },
    ]);
    const archive = unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()));
    expect([...archive['photos/001-maya-laughing.png']!]).toEqual([7, 8, 9]);
    expect(strFromU8(archive['media.csv']!)).toContain('media-a');
  });

  it('partitions source payload deterministically and describes every original in one manifest', () => {
    const items = [
      { ...media, id: 'media-a', byteSize: 60, publicationStatus: 'unpublished' as const },
      { ...media, id: 'media-b', byteSize: 40, publicationStatus: 'hidden' as const },
      { ...media, id: 'media-c', byteSize: 70 },
    ];
    const parts = partitionExportSnapshot(items, 100);

    expect(parts.map((part) => ({
      number: part.partNumber,
      ids: part.media.map(({ id }) => id),
      bytes: part.sourceBytes,
    }))).toEqual([
      { number: 1, ids: ['media-a', 'media-b'], bytes: 100 },
      { number: 2, ids: ['media-c'], bytes: 70 },
    ]);
    const manifest = buildExportManifest(parts);
    expect(manifest).toContain('part_number,archive_name,archive_path,media_id');
    expect(manifest).toContain('1,photos-001.zip,photos/001-maya-laughing.png,media-a');
    expect(manifest).toContain('unpublished');
    expect(manifest).toContain('hidden');
  });
});

import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildMediaCsv } from '../../worker/export/csv';
import { buildExportZip, exportPath } from '../../worker/export/zip-stream';

const media = {
  id: 'media-a', eventId: 'event-a', uploaderSessionId: 'session-a',
  objectKey: 'events/event-a/media/a', originalFilename: 'Maya, "laughing".png',
  mimeType: 'image/png' as const, declaredByteSize: 64, byteSize: 64,
  width: 800, height: 600, guestName: 'Zoë', caption: 'A bright, "golden" hour',
  uploadState: 'stored' as const, moderationStatus: 'approved' as const,
  idempotencyKey: 'upload-a', reservationExpiresAt: '2026-07-21T12:15:00.000Z',
  createdAt: '2026-07-21T12:00:00.000Z', approvedAt: '2026-07-21T12:05:00.000Z',
  deletedAt: null,
};

describe('export metadata', () => {
  it('escapes CSV values and emits stable columns', () => {
    const csv = buildMediaCsv([media]);
    expect(csv).toContain('media_id,original_filename,guest_name,caption,mime_type,byte_size,width,height,uploaded_at,approved_at');
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
});

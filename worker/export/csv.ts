import { csvCell as cell } from '../../shared/csv';
import type { ExportableMediaRecord } from '../db/types';
import { exportPartName, exportPath } from './paths';

const columns = [
  'media_id', 'original_filename', 'guest_name', 'caption', 'mime_type',
  'byte_size', 'width', 'height', 'uploaded_at', 'publication_status', 'published_at',
] as const;

export function buildMediaCsv(media: ExportableMediaRecord[]): string {
  const rows = media.map((item) => [
    item.id, item.originalFilename, item.guestName, item.caption, item.mimeType,
    item.byteSize, item.width, item.height, item.createdAt, item.publicationStatus, item.publishedAt,
  ].map(cell).join(','));
  return `${columns.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

const manifestColumns = [
  'part_number', 'archive_name', 'archive_index', 'archive_path', 'media_id', 'original_filename',
  'guest_name', 'caption', 'mime_type', 'byte_size', 'width', 'height',
  'uploaded_at', 'publication_status',
] as const;

/**
 * `archive_index` is the photo's 1-based position across the whole export run —
 * the same number its archive path carries — so for an album export it is the
 * album position, and parts never restart the count at 1.
 */
export function buildExportManifest(
  parts: Array<{ partNumber: number; media: ExportableMediaRecord[] }>,
  width = 3,
): string {
  let globalIndex = 0;
  const rows = parts.flatMap((part) => part.media.map((item) => {
    const row = [
      part.partNumber,
      exportPartName(part.partNumber),
      globalIndex + 1,
      exportPath(item, globalIndex, width),
      item.id,
      item.originalFilename,
      item.guestName,
      item.caption,
      item.mimeType,
      item.byteSize,
      item.width,
      item.height,
      item.createdAt,
      item.publicationStatus,
    ].map(cell).join(',');
    globalIndex += 1;
    return row;
  }));
  return `${manifestColumns.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

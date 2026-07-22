import type { MediaRecord } from '../db/types';
import { exportPartName, exportPath } from './paths';

const columns = [
  'media_id', 'original_filename', 'guest_name', 'caption', 'mime_type',
  'byte_size', 'width', 'height', 'uploaded_at', 'publication_status', 'published_at',
] as const;

function cell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildMediaCsv(media: MediaRecord[]): string {
  const rows = media.map((item) => [
    item.id, item.originalFilename, item.guestName, item.caption, item.mimeType,
    item.byteSize, item.width, item.height, item.createdAt, item.publicationStatus, item.publishedAt,
  ].map(cell).join(','));
  return `${columns.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

const manifestColumns = [
  'part_number', 'archive_name', 'archive_path', 'media_id', 'original_filename',
  'guest_name', 'caption', 'mime_type', 'byte_size', 'width', 'height',
  'uploaded_at', 'publication_status',
] as const;

export function buildExportManifest(parts: Array<{ partNumber: number; media: MediaRecord[] }>): string {
  const rows = parts.flatMap((part) => part.media.map((item, index) => [
    part.partNumber,
    exportPartName(part.partNumber),
    exportPath(item, index),
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
  ].map(cell).join(',')));
  return `${manifestColumns.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

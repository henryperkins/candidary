import { csvCell } from '../../shared/csv';
import type { ExportGuestbookEntryRecord } from '../db/types';

export interface GuestbookPhotoArchiveLocation {
  partNumber: number;
  path: string;
}

export type GuestbookPhotoArchiveMap = ReadonlyMap<string, GuestbookPhotoArchiveLocation>;

const COLUMNS = [
  'entry_type',
  'entry_id',
  'guest_name',
  'body',
  'created_at',
  'source_status',
  'guest_visibility',
  'media_id',
  'photo_archive_part',
  'photo_archive_path',
] as const;

export function buildGuestbookPrivateCsv(
  entries: ExportGuestbookEntryRecord[],
  photoArchiveByMediaId: GuestbookPhotoArchiveMap,
): string {
  const rows = entries.map((entry) => {
    const location = entry.mediaId ? photoArchiveByMediaId.get(entry.mediaId) : undefined;
    return [
      entry.source,
      entry.sourceId,
      entry.guestName,
      entry.body,
      entry.createdAt,
      entry.sourceState,
      entry.guestVisibility,
      entry.mediaId,
      location?.partNumber ?? null,
      location?.path ?? null,
    ].map(csvCell).join(',');
  });
  return `${COLUMNS.map(csvCell).join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

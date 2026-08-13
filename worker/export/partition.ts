import { MAX_EXPORT_PART_SOURCE_BYTES } from '../../shared/constants';
import type { ExportableMediaRecord } from '../db/types';

export interface ExportPartition {
  partNumber: number;
  media: ExportableMediaRecord[];
  sourceBytes: number;
}

export function partitionExportSnapshot(
  media: ExportableMediaRecord[],
  maxBytes = MAX_EXPORT_PART_SOURCE_BYTES,
): ExportPartition[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Export part size must be a positive integer.');
  const parts: ExportPartition[] = [];
  let current: ExportPartition | null = null;

  for (const item of media) {
    const byteSize = item.byteSize ?? item.declaredByteSize;
    if (byteSize > maxBytes) throw new Error('EXPORT_PART_LIMIT_EXCEEDED');
    if (!current || current.sourceBytes + byteSize > maxBytes) {
      current = { partNumber: parts.length + 1, media: [], sourceBytes: 0 };
      parts.push(current);
    }
    current.media.push(item);
    current.sourceBytes += byteSize;
  }
  return parts;
}

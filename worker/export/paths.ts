import type { MediaRecord } from '../db/types';

function safeBasename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot).toLowerCase().replace(/[^.a-z0-9]/gu, '') : '';
  const stem = (dot > 0 ? filename.slice(0, dot) : filename)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80) || 'photo';
  return `${stem}${extension}`;
}

export function exportPath(media: MediaRecord, index: number): string {
  return `photos/${String(index + 1).padStart(3, '0')}-${safeBasename(media.originalFilename)}`;
}

export function exportPartName(partNumber: number): string {
  return `photos-${String(partNumber).padStart(3, '0')}.zip`;
}

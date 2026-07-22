import { strToU8, zipSync } from 'fflate';

import type { MediaRecord } from '../db/types';
import { buildMediaCsv } from './csv';

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

export function buildExportZip(entries: Array<{ media: MediaRecord; bytes: Uint8Array }>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  entries.forEach((entry, index) => { files[exportPath(entry.media, index)] = entry.bytes; });
  files['media.csv'] = strToU8(buildMediaCsv(entries.map(({ media }) => media)));
  return zipSync(files, { level: 0 });
}

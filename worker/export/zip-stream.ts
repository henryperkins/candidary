import { strToU8, Zip, ZipPassThrough, zipSync } from 'fflate';

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

export function buildExportZipStream(entries: Array<{ media: MediaRecord; body: ReadableStream<Uint8Array> }>): ReadableStream<Uint8Array> {
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  let writes: Promise<void> = Promise.resolve();
  const zip = new Zip((error, bytes, final) => {
    if (error) {
      writes = writes.then(() => writer.abort(error));
      return;
    }
    writes = writes.then(() => writer.write(bytes));
    if (final) writes = writes.then(() => writer.close());
  });

  void (async () => {
    try {
      for (const [index, entry] of entries.entries()) {
        const file = new ZipPassThrough(exportPath(entry.media, index));
        zip.add(file);
        const reader = entry.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          file.push(chunk.value);
          await writes;
        }
        file.push(new Uint8Array(), true);
        await writes;
      }
      const metadata = new ZipPassThrough('media.csv');
      zip.add(metadata);
      metadata.push(strToU8(buildMediaCsv(entries.map(({ media }) => media))), true);
      zip.end();
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
    }
  })();

  return transform.readable;
}

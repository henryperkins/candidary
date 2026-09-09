import { strToU8, Zip, ZipPassThrough, zipSync } from 'fflate';

import type { ExportableMediaRecord } from '../db/types';
import { buildMediaCsv } from './csv';
import { exportPath } from './paths';

export { exportPath } from './paths';

/**
 * Archive numbering follows the whole export run, not one part: `startIndex` is
 * the 0-based run position of this part's first photo, so part 2 of a 51-part
 * export starts where part 1 left off instead of restarting at 001.
 */
export interface ZipNumbering {
  startIndex: number;
  width: number;
}

export function buildExportZip(
  entries: Array<{ media: ExportableMediaRecord; bytes: Uint8Array }>,
  numbering: ZipNumbering = { startIndex: 0, width: 3 },
): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  entries.forEach((entry, index) => {
    files[exportPath(entry.media, numbering.startIndex + index, numbering.width)] = entry.bytes;
  });
  files['media.csv'] = strToU8(buildMediaCsv(entries.map(({ media }) => media)));
  return zipSync(files, { level: 0 });
}

export function buildExportZipStream(
  entries: Array<{ media: ExportableMediaRecord; body: ReadableStream<Uint8Array> }>,
  numbering: ZipNumbering = { startIndex: 0, width: 3 },
): ReadableStream<Uint8Array> {
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
        const file = new ZipPassThrough(exportPath(entry.media, numbering.startIndex + index, numbering.width));
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

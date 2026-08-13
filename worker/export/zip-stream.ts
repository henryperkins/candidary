import { strToU8, Zip, ZipPassThrough, zipSync } from 'fflate';

import type { ExportableMediaRecord } from '../db/types';
import { buildMediaCsv } from './csv';
import { exportPath } from './paths';

export { exportPath } from './paths';

export function buildExportZip(entries: Array<{ media: ExportableMediaRecord; bytes: Uint8Array }>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  entries.forEach((entry, index) => { files[exportPath(entry.media, index)] = entry.bytes; });
  files['media.csv'] = strToU8(buildMediaCsv(entries.map(({ media }) => media)));
  return zipSync(files, { level: 0 });
}

export function buildExportZipStream(entries: Array<{ media: ExportableMediaRecord; body: ReadableStream<Uint8Array> }>): ReadableStream<Uint8Array> {
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

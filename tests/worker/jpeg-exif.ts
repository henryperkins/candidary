export interface ExifEntrySpec {
  tag: number;
  value: string;
}

function asciiBytes(value: string): Uint8Array {
  const chars = [...value].map((char) => char.charCodeAt(0));
  return new Uint8Array([...chars, 0]);
}

/**
 * A minimal TIFF payload: byte order, magic, one IFD0, and ASCII values
 * stored after the IFD block. All offsets are relative to the TIFF start.
 */
export function buildExifTiff(entries: ExifEntrySpec[], littleEndian = true): Uint8Array {
  const headerSize = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let valueCursor = headerSize + ifdSize;
  const valueParts: { offset: number; bytes: Uint8Array }[] = [];

  const entryBytes = entries.map(({ tag, value }) => {
    const data = asciiBytes(value);
    const entry = new Uint8Array(12);
    const view = new DataView(entry.buffer);
    view.setUint16(0, tag, littleEndian);
    view.setUint16(2, 2, littleEndian);
    view.setUint32(4, data.length, littleEndian);
    if (data.length <= 4) {
      entry.set(data, 8);
    } else {
      view.setUint32(8, valueCursor, littleEndian);
      valueParts.push({ offset: valueCursor, bytes: data });
      valueCursor += data.length;
    }
    return entry;
  });

  const tiff = new Uint8Array(valueCursor);
  const view = new DataView(tiff.buffer);
  tiff.set(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, 0x002a, littleEndian);
  view.setUint32(4, headerSize, littleEndian);
  view.setUint16(headerSize, entries.length, littleEndian);
  entryBytes.forEach((entry, index) => tiff.set(entry, headerSize + 2 + index * 12));
  view.setUint32(headerSize + 2 + entries.length * 12, 0, littleEndian);
  for (const part of valueParts) tiff.set(part.bytes, part.offset);
  return tiff;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.length;
  }
  return result;
}

const SOS = Uint8Array.of(0xff, 0xda, 0x00, 0x02);
const EOI = Uint8Array.of(0xff, 0xd9);
// A minimal baseline SOF0 carrying 4x6 dimensions so the existing image-header
// inspector accepts the fixture as a real JPEG.
const SOF0 = Uint8Array.of(
  0xff, 0xc0, 0x00, 0x0b, 0x08,
  0x00, 0x04, 0x00, 0x06,
  0x01, 0x01, 0x11, 0x00,
);

export function jpegWithExif(tiff: Uint8Array, afterSos = false): Uint8Array {
  const signature = Uint8Array.of(0x45, 0x78, 0x69, 0x66, 0x00, 0x00);
  const app1Length = 2 + signature.length + tiff.length;
  const app1 = new Uint8Array(2 + app1Length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  new DataView(app1.buffer).setUint16(2, app1Length, false);
  app1.set(signature, 4);
  app1.set(tiff, 4 + signature.length);

  return concat(afterSos
    ? [Uint8Array.of(0xff, 0xd8), SOS, app1, EOI]
    : [Uint8Array.of(0xff, 0xd8), app1, SOF0, SOS, EOI]);
}

/** A JPEG with a JFIF APP0 but no EXIF APP1 before Start of Scan. */
export function jpegWithoutExif(): Uint8Array {
  const jfif = Uint8Array.of(
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  );
  return concat([Uint8Array.of(0xff, 0xd8), jfif, SOF0, SOS, EOI]);
}

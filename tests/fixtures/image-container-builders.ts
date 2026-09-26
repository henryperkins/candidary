// ISO BMFF structure fixtures only. Payloads do not establish codec support.
export const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
};
const text = (value: string) => new TextEncoder().encode(value);
export const u16 = (value: number) => Uint8Array.of(value >> 8, value & 255);
export const u32 = (value: number) => Uint8Array.of(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
export function box(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(u32(payload.length + 8), text(type), payload);
}
const full = (version = 0) => Uint8Array.of(version, 0, 0, 0);

export function primaryHeif(options: {
  primaryId: number;
  items: Array<{ id: number; width: number; height: number }>;
  grid?: { width: number; height: number };
  sequence?: boolean;
  family?: 'heic' | 'avif';
  genericBrand?: boolean;
  lateBytes?: number;
}): Uint8Array<ArrayBuffer> {
  const family = options.family ?? 'heic';
  const codec = family === 'avif' ? 'av01' : 'hvc1';
  const primary = options.items.find((item) => item.id === options.primaryId)!;
  const brand = options.sequence ? (family === 'avif' ? 'avis' : 'hevc') : options.genericBrand ? 'mif1' : family;
  const ftyp = box('ftyp', concat(text(brand), u32(0), text(options.sequence ? 'msf1' : 'mif1'), text(brand)));
  if (options.sequence) {
    const sample = new Uint8Array(78);
    new DataView(sample.buffer).setUint16(6, 1);
    new DataView(sample.buffer).setUint16(24, primary.width);
    new DataView(sample.buffer).setUint16(26, primary.height);
    const stsd = box('stsd', concat(full(), u32(1), box(codec, sample)));
    const stsz = box('stsz', concat(full(), u32(1), u32(3)));
    const stts = box('stts', concat(full(), u32(1), u32(3), u32(100)));
    const mdhd = box('mdhd', concat(full(), u32(0), u32(0), u32(1000), u32(300), u32(0)));
    const hdlr = box('hdlr', concat(full(), u32(0), text('pict'), new Uint8Array(12)));
    return concat(ftyp, box('moov', box('trak', box('mdia', concat(mdhd, hdlr, box('minf', box('stbl', concat(stsd, stsz, stts))))))), box('mdat', Uint8Array.of(1, 2, 3)));
  }
  const infe = options.items.map((item) => box('infe', concat(full(2), u16(item.id), u16(0), text(options.grid && item.id === options.primaryId ? 'grid' : codec), Uint8Array.of(0))));
  const iinf = box('iinf', concat(full(), u16(infe.length), ...infe));
  const ipco = box('ipco', concat(...options.items.map((item) => box('ispe', concat(full(), u32(item.width), u32(item.height))))));
  const ipma = box('ipma', concat(full(), u32(options.items.length), ...options.items.map((item, index) => concat(u16(item.id), Uint8Array.of(1, index + 1)))));
  const parts = [box('pitm', concat(full(), u16(options.primaryId))), iinf, box('iprp', concat(ipco, ipma))];
  if (options.grid) {
    const tiles = options.items.filter((item) => item.id !== options.primaryId);
    const rows = Math.ceil(options.grid.height / tiles[0]!.height);
    const cols = Math.ceil(options.grid.width / tiles[0]!.width);
    const grid = concat(Uint8Array.of(0, 0, rows - 1, cols - 1), u16(options.grid.width), u16(options.grid.height));
    parts.push(box('iloc', concat(full(1), Uint8Array.of(0x44, 0), u16(1), u16(options.primaryId), u16(1), u16(0), u16(1), u32(0), u32(grid.length))));
    parts.push(box('iref', concat(full(), box('dimg', concat(u16(options.primaryId), u16(tiles.length), ...tiles.map((item) => u16(item.id)))))));
    parts.push(box('idat', grid));
  }
  return concat(ftyp, ...(options.lateBytes ? [box('mdat', new Uint8Array(options.lateBytes))] : []), box('meta', concat(full(), ...parts)));
}

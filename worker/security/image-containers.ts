import type { ImageEvidence } from '../../shared/image-formats';
import { assertImageRange, imageAscii, imageView, ImageInspectionError, ImageReadCursor, malformed, runImageParser, type ImageParser, type ImageRangeReader } from './image-reader-core';
import { imageEvidence } from './image-raster';

interface Box { type: string; start: number; end: number; children: Box[] }
const CONTAINERS = new Set(['meta', 'iprp', 'ipco', 'iinf', 'iref', 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
const HEVC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const AV1_BRANDS = new Set(['avif', 'avis']);

function* boxes(reader: ImageReadCursor, start: number, end: number, depth = 0): ImageParser<Box[]> {
  if (depth > 32) throw new ImageInspectionError('IMAGE_METADATA_LIMIT', 'Image box depth exceeds the supported budget.');
  const result: Box[] = [];
  for (let offset = start; offset < end;) {
    reader.structure();
    if (end - offset < 8) malformed('Image box header is truncated.');
    const header = yield* reader.read(offset, 8);
    let size = imageView(header).getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (end - offset < 16) malformed('Image extended box is truncated.');
      const large = imageView(yield* reader.read(offset + 8, 8)).getBigUint64(0);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) malformed('Image box size exceeds safe bounds.');
      size = Number(large); headerSize = 16;
    } else if (size === 0) size = end - offset;
    if (size < headerSize || size > end - offset) malformed('Image box exceeds its parent bounds.');
    const node: Box = { type: imageAscii(header, 4, 4), start: offset + headerSize, end: offset + size, children: [] };
    if (CONTAINERS.has(node.type)) {
      let skip = node.type === 'meta' || node.type === 'iref' ? 4 : node.type === 'stsd' ? 8 : 0;
      if (node.type === 'iinf') {
        if (node.end - node.start < 6) malformed('Image item table is truncated.');
        skip = (yield* reader.read(node.start, 1))[0] === 0 ? 6 : 8;
      }
      if (skip > node.end - node.start) malformed('Image container header is truncated.');
      node.children = yield* boxes(reader, node.start + skip, node.end, depth + 1);
    }
    result.push(node);
    offset += size;
  }
  return result;
}

const one = (nodes: Box[], type: string): Box | undefined => {
  const found = nodes.filter((node) => node.type === type);
  if (found.length > 1) malformed(`Image has duplicate ${type} boxes.`);
  return found[0];
};
const required = (nodes: Box[], type: string): Box => one(nodes, type) ?? malformed(`Image is missing ${type}.`);

class Fields {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(length: number): Uint8Array {
    assertImageRange(this.bytes.length, this.offset, length);
    const part = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return part;
  }
  uint(length: number): number {
    if (length === 0) return 0;
    if (![1, 2, 4, 8].includes(length)) malformed('Image integer field width is unsupported.');
    const bytes = this.take(length), view = imageView(bytes);
    if (length === 1) return bytes[0]!;
    if (length === 2) return view.getUint16(0);
    if (length === 4) return view.getUint32(0);
    const value = view.getBigUint64(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) malformed('Image integer exceeds safe bounds.');
    return Number(value);
  }
  text(length: number): string { return imageAscii(this.take(length)); }
}

function* fields(reader: ImageReadCursor, node: Box): ImageParser<Fields> {
  return new Fields(yield* reader.read(node.start, node.end - node.start));
}
function codecFamily(type: string): ImageEvidence['family'] {
  if (type === 'hvc1' || type === 'hev1') return 'heic';
  if (type === 'av01') return 'avif';
  if (type === 'jpeg' || type === 'j2k1' || type === 'unci') return 'heif';
  throw new ImageInspectionError('IMAGE_TYPE_UNSUPPORTED', 'HEIF primary codec is unsupported.');
}
function checkBrands(brands: Set<string>, family: ImageEvidence['family']): void {
  const hevc = [...brands].some((brand) => HEVC_BRANDS.has(brand));
  const av1 = [...brands].some((brand) => AV1_BRANDS.has(brand));
  if ((hevc && family !== 'heic') || (av1 && family !== 'avif')) malformed('Image codec contradicts its brands.');
}

interface Item { type: string; hidden: boolean }
interface Extent { offset: number; length: number }

function* inspectItems(reader: ImageReadCursor, meta: Box, brands: Set<string>): ImageParser<ImageEvidence> {
  const primary = yield* fields(reader, required(meta.children, 'pitm'));
  const primaryVersion = primary.uint(4) >>> 24;
  if (primaryVersion > 1) malformed('HEIF primary version is unsupported.');
  const primaryId = primary.uint(primaryVersion === 0 ? 2 : 4);
  const table = required(meta.children, 'iinf');
  const tableHeader = new Fields(yield* reader.read(table.start, table.children[0] ? table.children[0].start - 8 - table.start : table.end - table.start));
  const tableVersion = tableHeader.uint(4) >>> 24;
  const declaredItems = tableHeader.uint(tableVersion === 0 ? 2 : 4);
  if (declaredItems !== table.children.length) malformed('HEIF item count is inconsistent.');
  const items = new Map<number, Item>();
  for (const node of table.children) {
    reader.structure();
    if (node.type !== 'infe') malformed('HEIF item information is invalid.');
    const data = yield* fields(reader, node);
    const versionFlags = data.uint(4), version = versionFlags >>> 24;
    if (version !== 2 && version !== 3) throw new ImageInspectionError('IMAGE_TYPE_UNSUPPORTED', 'HEIF item information version is unsupported.');
    const id = data.uint(version === 2 ? 2 : 4);
    if (data.uint(2) !== 0) throw new ImageInspectionError('IMAGE_TYPE_UNSUPPORTED', 'Protected HEIF items are unsupported.');
    const type = data.text(4);
    if (items.has(id)) malformed('HEIF has duplicate item identities.');
    items.set(id, { type, hidden: (versionFlags & 1) !== 0 });
  }
  if (!items.has(primaryId)) malformed('HEIF primary item is missing.');

  const iprp = required(meta.children, 'iprp');
  const properties = required(iprp.children, 'ipco').children;
  const associations = new Map<number, number[]>();
  for (const node of iprp.children.filter((box) => box.type === 'ipma')) {
    const data = yield* fields(reader, node);
    const versionFlags = data.uint(4), version = versionFlags >>> 24;
    if (version > 1) malformed('HEIF property association version is unsupported.');
    const count = data.uint(4);
    for (let i = 0; i < count; i++) {
      reader.structure();
      const id = data.uint(version === 0 ? 2 : 4);
      const length = data.uint(1);
      const indexes = associations.get(id) ?? [];
      for (let j = 0; j < length; j++) {
        reader.structure();
        const index = data.uint(versionFlags & 1 ? 2 : 1) & (versionFlags & 1 ? 0x7fff : 0x7f);
        if (index > properties.length) malformed('HEIF property index is out of bounds.');
        if (index) indexes.push(index - 1);
      }
      associations.set(id, indexes);
    }
  }

  const locations = new Map<number, Extent[]>();
  const iloc = one(meta.children, 'iloc');
  if (iloc) {
    const data = yield* fields(reader, iloc);
    const version = data.uint(4) >>> 24;
    if (version > 2) malformed('HEIF location version is unsupported.');
    const first = data.uint(1), second = data.uint(1);
    const offsetSize = first >> 4, lengthSize = first & 15, baseSize = second >> 4;
    const indexSize = version ? second & 15 : 0;
    const count = data.uint(version < 2 ? 2 : 4);
    const idat = one(meta.children, 'idat');
    for (let i = 0; i < count; i++) {
      reader.structure();
      const id = data.uint(version < 2 ? 2 : 4);
      const method = version ? data.uint(2) & 15 : 0;
      const dataReference = data.uint(2), base = data.uint(baseSize), extentCount = data.uint(2);
      const extents: Extent[] = [];
      for (let j = 0; j < extentCount; j++) {
        reader.structure();
        data.uint(indexSize);
        const offset = data.uint(offsetSize), length = data.uint(lengthSize);
        // External/derived construction is never followed. It remains unavailable
        // to the grid reader instead of becoming an arbitrary source reference.
        if (dataReference === 0 && (method === 0 || (method === 1 && idat))) {
          const absolute = base + offset + (method === 1 ? idat!.start : 0);
          assertImageRange(method === 1 ? idat!.end : reader.size, absolute, length);
          extents.push({ offset: absolute, length });
        }
      }
      if (locations.has(id)) malformed('HEIF has duplicate item locations.');
      locations.set(id, extents);
    }
  }
  const derived = new Map<number, number[]>();
  const iref = one(meta.children, 'iref');
  if (iref) {
    const version = (yield* reader.read(iref.start, 1))[0]!;
    if (version > 1) malformed('HEIF reference version is unsupported.');
    for (const node of iref.children) {
      if (node.type !== 'dimg') continue;
      const data = yield* fields(reader, node);
      const source = data.uint(version ? 4 : 2), count = data.uint(2);
      const refs = derived.get(source) ?? [];
      for (let i = 0; i < count; i++) { reader.structure(); refs.push(data.uint(version ? 4 : 2)); }
      derived.set(source, refs);
    }
  }

  const resolved = new Map<number, ImageEvidence>();
  const active = new Set<number>();
  function* resolveItem(id: number, depth = 0): ImageParser<ImageEvidence> {
    if (depth > 32) throw new ImageInspectionError('IMAGE_METADATA_LIMIT', 'HEIF reference depth exceeds the supported budget.');
    if (active.has(id)) malformed('HEIF grid references contain a cycle.');
    const cached = resolved.get(id);
    if (cached) return cached;
    const item = items.get(id);
    if (!item) malformed('HEIF references a missing item.');
    active.add(id);
    const dimensions = (associations.get(id) ?? []).map((index) => properties[index]!).filter((property) => property.type === 'ispe');
    if (dimensions.length !== 1) malformed('HEIF primary or tile dimensions are missing or ambiguous.');
    const data = yield* fields(reader, dimensions[0]!);
    if (data.uint(4) !== 0) malformed('HEIF dimensions version is invalid.');
    const width = data.uint(4), height = data.uint(4);
    let evidence: ImageEvidence;
    if (item.type !== 'grid') evidence = imageEvidence(codecFamily(item.type), width, height);
    else {
      const extents = locations.get(id) ?? [];
      const length = extents.reduce((sum, extent) => sum + extent.length, 0);
      if (length < 8 || length > 12) malformed('HEIF grid descriptor is unavailable or invalid.');
      const descriptor = new Uint8Array(length);
      let offset = 0;
      for (const extent of extents) { descriptor.set(yield* reader.read(extent.offset, extent.length), offset); offset += extent.length; }
      const grid = new Fields(descriptor);
      if (grid.uint(1) !== 0) malformed('HEIF grid version is invalid.');
      const flags = grid.uint(1), rows = grid.uint(1) + 1, columns = grid.uint(1) + 1;
      if (flags & ~1) malformed('HEIF grid flags are invalid.');
      if (grid.uint(flags & 1 ? 4 : 2) !== width || grid.uint(flags & 1 ? 4 : 2) !== height) malformed('HEIF grid dimensions disagree.');
      const refs = derived.get(id) ?? [];
      if (refs.length !== rows * columns) malformed('HEIF grid tile count is inconsistent.');
      const tiles: ImageEvidence[] = [];
      for (const ref of refs) tiles.push(yield* resolveItem(ref, depth + 1));
      const first = tiles[0]!;
      if (tiles.some((tile) => tile.family !== first.family || tile.width !== first.width || tile.height !== first.height)
        || width > columns * first.width || width <= (columns - 1) * first.width
        || height > rows * first.height || height <= (rows - 1) * first.height) malformed('HEIF grid tile geometry is invalid.');
      evidence = imageEvidence(first.family, width, height);
    }
    active.delete(id);
    resolved.set(id, evidence);
    return evidence;
  }
  const evidence = yield* resolveItem(primaryId);
  checkBrands(brands, evidence.family);
  const visible = [...items].filter(([, item]) => !item.hidden).map(([id]) => id);
  return { ...evidence, primaryIndex: Math.max(0, visible.indexOf(primaryId)) };
}

function* inspectSequence(reader: ImageReadCursor, moov: Box, brands: Set<string>, mediaBytes: number): ImageParser<ImageEvidence> {
  for (const track of moov.children.filter((node) => node.type === 'trak')) {
    const mdia = one(track.children, 'mdia');
    if (!mdia) continue;
    const handler = one(mdia.children, 'hdlr');
    if (!handler || handler.end - handler.start < 12) continue;
    const handlerType = imageAscii(yield* reader.read(handler.start + 8, 4));
    if (handlerType !== 'pict' && handlerType !== 'vide') continue;
    const stbl = required(required(mdia.children, 'minf').children, 'stbl');
    const descriptions = required(stbl.children, 'stsd');
    const sd = new Fields(yield* reader.read(descriptions.start, 8));
    if (sd.uint(4) !== 0 || sd.uint(4) !== descriptions.children.length || descriptions.children.length !== 1) malformed('HEIF sequence sample descriptions are invalid.');
    const sample = descriptions.children[0]!;
    if (sample.end - sample.start < 78) malformed('HEIF sequence visual entry is truncated.');
    const family = codecFamily(sample.type);
    const size = imageView(yield* reader.read(sample.start + 24, 4));
    const sampleSizes = yield* fields(reader, required(stbl.children, 'stsz'));
    if (sampleSizes.uint(4) !== 0) malformed('HEIF sample size version is invalid.');
    const fixedSize = sampleSizes.uint(4), count = sampleSizes.uint(4);
    if (!count) malformed('HEIF sequence has no samples.');
    let totalBytes = fixedSize * count;
    if (!fixedSize) {
      for (let i = 0; i < count; i++) { reader.structure(); const bytes = sampleSizes.uint(4); if (!bytes) malformed('HEIF sequence has an empty sample.'); totalBytes += bytes; }
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes > mediaBytes) malformed('HEIF sequence samples exceed available media.');
    const timing = yield* fields(reader, required(stbl.children, 'stts'));
    if (timing.uint(4) !== 0) malformed('HEIF sample timing version is invalid.');
    const entries = timing.uint(4);
    let timedSamples = 0;
    for (let i = 0; i < entries; i++) {
      reader.structure(); const samples = timing.uint(4), duration = timing.uint(4);
      if (!samples || !duration) malformed('HEIF sequence timing is invalid.');
      timedSamples += samples;
    }
    if (timedSamples !== count) malformed('HEIF sequence timing count disagrees.');
    const mediaHeader = yield* fields(reader, required(mdia.children, 'mdhd'));
    const version = mediaHeader.uint(4) >>> 24;
    if (version > 1) malformed('HEIF media header version is invalid.');
    mediaHeader.take(version ? 16 : 8);
    if (!mediaHeader.uint(4)) malformed('HEIF sequence timescale is invalid.');
    checkBrands(brands, family);
    return imageEvidence(family, size.getUint16(0), size.getUint16(2), count, true);
  }
  return malformed('HEIF sequence has no image sample track.');
}

export function* inspectBmffStructure(reader: ImageReadCursor): ImageParser<ImageEvidence> {
  const top = yield* boxes(reader, 0, reader.size);
  const ftyp = required(top, 'ftyp');
  if (top[0] !== ftyp) malformed('HEIF file type must precede image data.');
  const data = yield* fields(reader, ftyp);
  const brands = new Set([data.text(4)]);
  data.uint(4);
  while (data.offset < data.bytes.length) { reader.structure(); brands.add(data.text(4)); }
  if (![...brands].some((brand) => HEVC_BRANDS.has(brand) || AV1_BRANDS.has(brand) || brand === 'mif1' || brand === 'msf1')) {
    throw new ImageInspectionError('IMAGE_TYPE_UNSUPPORTED', 'ISO-BMFF image type is unsupported.');
  }
  const moov = one(top, 'moov');
  if (moov) {
    const mediaBytes = top.filter((node) => node.type === 'mdat').reduce((sum, node) => sum + node.end - node.start, 0);
    return yield* inspectSequence(reader, moov, brands, mediaBytes);
  }
  if (brands.has('msf1') || brands.has('avis')) malformed('HEIF sequence brands lack timed sample evidence.');
  return yield* inspectItems(reader, required(top, 'meta'), brands);
}

export function inspectBmff(reader: ImageRangeReader): Promise<ImageEvidence> {
  return runImageParser(inspectBmffStructure(new ImageReadCursor(reader.size)), reader);
}

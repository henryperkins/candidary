// Structurally valid parser fixtures, deliberately not codec/photograph evidence.
export function structuralPng(width: number, height: number, size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(size, 64));
  const view = new DataView(bytes.buffer);
  const chunk = (offset: number, type: string, length: number) => {
    view.setUint32(offset, length);
    bytes.set(new TextEncoder().encode(type), offset + 4);
  };
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  chunk(8, 'IHDR', 13);
  view.setUint32(16, width); view.setUint32(20, height);
  bytes[24] = 8; bytes[25] = 2;
  chunk(33, 'IDAT', bytes.length - 57);
  chunk(bytes.length - 12, 'IEND', 0);
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    let crc = 0xffffffff;
    for (let i = offset + 4; i < offset + 8 + length; i++) {
      crc ^= bytes[i]!;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    view.setUint32(offset + 8 + length, (crc ^ 0xffffffff) >>> 0);
    offset += length + 12;
  }
  return bytes.subarray(0, size);
}

export function structuralWebp(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(26);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 18, true);
  bytes.set(new TextEncoder().encode('WEBPVP8L'), 8);
  view.setUint32(16, 5, true);
  bytes[20] = 0x2f;
  view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return bytes;
}

export function withLeadingJpegApps(jpeg: Uint8Array, count = 22): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(jpeg.length + count * 60_004);
  result.set([0xff, 0xd8]);
  for (let i = 0; i < count; i++) result.set([0xff, 0xe2, 0xea, 0x62], 2 + i * 60_004);
  result.set(jpeg.subarray(2), 2 + count * 60_004);
  return result;
}

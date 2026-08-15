import { describe, expect, it } from 'vitest';

import { inspectJpegCaptureTime } from '../../worker/security/exif-capture-time';
import {
  buildExifTiff,
  buildExifTiffSubIfd,
  jpegWithExif,
  jpegWithoutExif,
} from './jpeg-exif';

const DATE_TIME_ORIGINAL = 0x9003;
const OFFSET_TIME_ORIGINAL = 0x9011;

describe('inspectJpegCaptureTime', () => {
  it('reads DateTimeOriginal from a little-endian APP1 before Start of Scan', () => {
    const jpeg = jpegWithExif(buildExifTiff([
      { tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' },
    ]));

    expect(inspectJpegCaptureTime(jpeg)).toEqual({
      dateTimeOriginal: '2026:09:19 17:42:30',
      offsetTimeOriginal: null,
    });
  });

  it('reads OffsetTimeOriginal alongside DateTimeOriginal', () => {
    const jpeg = jpegWithExif(buildExifTiff([
      { tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' },
      { tag: OFFSET_TIME_ORIGINAL, value: '+05:00' },
    ]));

    expect(inspectJpegCaptureTime(jpeg)).toEqual({
      dateTimeOriginal: '2026:09:19 17:42:30',
      offsetTimeOriginal: '+05:00',
    });
  });

  it('follows the Exif SubIFD pointer to the capture-time tags', () => {
    const jpeg = jpegWithExif(buildExifTiffSubIfd([
      { tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' },
      { tag: OFFSET_TIME_ORIGINAL, value: '+05:00' },
    ]));

    expect(inspectJpegCaptureTime(jpeg)).toEqual({
      dateTimeOriginal: '2026:09:19 17:42:30',
      offsetTimeOriginal: '+05:00',
    });
  });

  it('reads a big-endian Exif SubIFD', () => {
    const jpeg = jpegWithExif(buildExifTiffSubIfd([
      { tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' },
    ], false));

    expect(inspectJpegCaptureTime(jpeg)).toEqual({
      dateTimeOriginal: '2026:09:19 17:42:30',
      offsetTimeOriginal: null,
    });
  });

  it('keeps a valid DateTimeOriginal when a sibling offset entry is out of bounds', () => {
    const tiff = buildExifTiff([
      { tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' },
      { tag: OFFSET_TIME_ORIGINAL, value: '+05:00' },
    ]);
    // Point the second entry's value offset past the TIFF payload.
    new DataView(tiff.buffer).setUint32(8 + 2 + 12 + 8, tiff.length + 50, true);

    expect(inspectJpegCaptureTime(jpegWithExif(tiff))).toEqual({
      dateTimeOriginal: '2026:09:19 17:42:30',
      offsetTimeOriginal: null,
    });
  });

  it('reads big-endian TIFF payloads', () => {
    const jpeg = jpegWithExif(buildExifTiff([
      { tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' },
    ], false));

    expect(inspectJpegCaptureTime(jpeg)).toEqual({
      dateTimeOriginal: '2026:09:19 17:42:30',
      offsetTimeOriginal: null,
    });
  });

  it('ignores APP1 segments after Start of Scan', () => {
    const jpeg = jpegWithExif(buildExifTiff([
      { tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' },
    ]), true);

    expect(inspectJpegCaptureTime(jpeg)).toBeNull();
  });

  it('returns null when no EXIF APP1 precedes Start of Scan', () => {
    expect(inspectJpegCaptureTime(jpegWithoutExif())).toBeNull();
  });

  it('returns null when DateTimeOriginal is missing', () => {
    const jpeg = jpegWithExif(buildExifTiff([
      { tag: OFFSET_TIME_ORIGINAL, value: '+05:00' },
    ]));

    expect(inspectJpegCaptureTime(jpeg)).toBeNull();
  });

  it('returns null for truncated segments and out-of-bounds TIFF offsets', () => {
    const valid = jpegWithExif(buildExifTiff([
      { tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' },
    ]));
    // Cut inside the APP1 payload so the declared segment length exceeds the
    // available bytes.
    expect(inspectJpegCaptureTime(valid.slice(0, 10))).toBeNull();

    // A TIFF whose IFD0 offset points past its own payload.
    const tiff = buildExifTiff([{ tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' }]);
    new DataView(tiff.buffer).setUint32(4, tiff.length + 100, true);
    expect(inspectJpegCaptureTime(jpegWithExif(tiff))).toBeNull();
  });

  it('returns null when the Exif SubIFD pointer is out of bounds', () => {
    const tiff = buildExifTiffSubIfd([
      { tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' },
    ]);
    // IFD0's single pointer entry begins after the header and count; its value
    // field is eight bytes into the entry.
    new DataView(tiff.buffer).setUint32(8 + 2 + 8, tiff.length + 100, true);
    expect(inspectJpegCaptureTime(jpegWithExif(tiff))).toBeNull();
  });

  it('does not inspect segments beyond the scan ceiling', () => {
    const jpeg = jpegWithExif(buildExifTiff([
      { tag: DATE_TIME_ORIGINAL, value: '2026:09:19 17:42:30' },
    ]));

    // The APP1 payload itself begins well past this ceiling.
    expect(inspectJpegCaptureTime(jpeg, 16)).toBeNull();
  });
});

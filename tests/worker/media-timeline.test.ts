import { describe, expect, it } from 'vitest';

import type { SupportedImageType } from '../../shared/constants';
import { resolveMediaTimeline } from '../../worker/media-timeline';
import { buildExifTiff, jpegWithExif, jpegWithoutExif } from './jpeg-exif';

const DATE_TIME_ORIGINAL = 0x9003;
const OFFSET_TIME_ORIGINAL = 0x9011;

function timeline(input: {
  mimeType?: SupportedImageType;
  bytes?: Uint8Array;
  eventStartAt?: string;
  eventTimezone?: string;
  storedAt?: string;
}) {
  return resolveMediaTimeline({
    mimeType: input.mimeType ?? 'image/jpeg',
    bytes: input.bytes ?? jpegWithoutExif(),
    eventStartAt: input.eventStartAt ?? '2026-09-19T22:00:00.000Z',
    eventTimezone: input.eventTimezone ?? 'America/Chicago',
    storedAt: input.storedAt ?? '2026-09-19T22:50:00.000Z',
  });
}

function jpeg(capture: string, offset: string | null = null): Uint8Array {
  const entries = offset === null
    ? [{ tag: DATE_TIME_ORIGINAL, value: capture }]
    : [
        { tag: DATE_TIME_ORIGINAL, value: capture },
        { tag: OFFSET_TIME_ORIGINAL, value: offset },
      ];
  return jpegWithExif(buildExifTiff(entries));
}

describe('resolveMediaTimeline', () => {
  it('honors an offset-bearing capture time and normalizes it to UTC', () => {
    expect(timeline({
      bytes: jpeg('2026:09:19 10:42:30', '+05:00'),
    })).toEqual({
      capturedAt: '2026-09-19T05:42:30.000Z',
      timelineAt: '2026-09-19T05:42:30.000Z',
      timelineSource: 'capture',
    });
  });

  it('places an offset-free capture time in the event time zone', () => {
    expect(timeline({
      bytes: jpeg('2026:09:19 17:42:30'),
    })).toEqual({
      capturedAt: '2026-09-19T22:42:30.000Z',
      timelineAt: '2026-09-19T22:42:30.000Z',
      timelineSource: 'capture',
    });
  });

  it('accepts a capture time exactly five minutes after receipt', () => {
    expect(timeline({
      bytes: jpeg('2026:09:19 17:55:00'),
      storedAt: '2026-09-19T22:50:00.000Z',
    })).toEqual({
      capturedAt: '2026-09-19T22:55:00.000Z',
      timelineAt: '2026-09-19T22:55:00.000Z',
      timelineSource: 'capture',
    });
  });

  it.each<SupportedImageType>([
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
  ])('uses received time for the unsupported container %s', (mimeType) => {
    expect(timeline({ mimeType })).toEqual({
      capturedAt: null,
      timelineAt: '2026-09-19T22:50:00.000Z',
      timelineSource: 'received',
    });
  });

  it('falls back to received time for malformed or missing EXIF', () => {
    expect(timeline({ bytes: jpegWithoutExif() })).toEqual({
      capturedAt: null,
      timelineAt: '2026-09-19T22:50:00.000Z',
      timelineSource: 'received',
    });
  });

  it('falls back when the event start is the migration sentinel', () => {
    expect(timeline({
      bytes: jpeg('2026:09:19 17:42:30'),
      eventStartAt: '1970-01-01T00:00:00.000Z',
    })).toEqual({
      capturedAt: null,
      timelineAt: '2026-09-19T22:50:00.000Z',
      timelineSource: 'received',
    });
  });

  it('falls back when capture precedes the event start by more than 24 hours', () => {
    expect(timeline({
      bytes: jpeg('2026:09:18 21:00:00', '+00:00'),
    })).toEqual({
      capturedAt: null,
      timelineAt: '2026-09-19T22:50:00.000Z',
      timelineSource: 'received',
    });
  });

  it('falls back when capture is more than five minutes after receipt', () => {
    expect(timeline({
      bytes: jpeg('2026:09:19 18:00:00'),
      storedAt: '2026-09-19T22:50:00.000Z',
    })).toEqual({
      capturedAt: null,
      timelineAt: '2026-09-19T22:50:00.000Z',
      timelineSource: 'received',
    });
  });

  it('falls back for an offset-free time inside a spring-forward gap', () => {
    expect(timeline({
      bytes: jpeg('2026:03:08 02:30:00'),
      eventStartAt: '2026-03-08T08:00:00.000Z',
      storedAt: '2026-03-08T10:00:00.000Z',
    })).toEqual({
      capturedAt: null,
      timelineAt: '2026-03-08T10:00:00.000Z',
      timelineSource: 'received',
    });
  });

  it('resolves a fall-back overlap to the earlier occurrence', () => {
    expect(timeline({
      bytes: jpeg('2026:11:01 01:30:00'),
      eventStartAt: '2026-11-01T08:00:00.000Z',
      storedAt: '2026-11-01T08:10:00.000Z',
    })).toEqual({
      capturedAt: '2026-11-01T06:30:00.000Z',
      timelineAt: '2026-11-01T06:30:00.000Z',
      timelineSource: 'capture',
    });
  });

  it('falls back for an impossible calendar date', () => {
    expect(timeline({ bytes: jpeg('2026:02:30 12:00:00') })).toEqual({
      capturedAt: null,
      timelineAt: '2026-09-19T22:50:00.000Z',
      timelineSource: 'received',
    });
  });
});

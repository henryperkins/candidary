import { describe, expect, it } from 'vitest';

import type { SupportedImageType } from '../../shared/constants';
import { resolveMediaTimeline, resolveMediaTimelineSource } from '../../worker/media-timeline';
import { buildExifTiffSubIfd, jpegWithExif, jpegWithoutExif } from './jpeg-exif';
import { withLeadingJpegApps } from '../fixtures/raster-builders';

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
  return jpegWithExif(buildExifTiffSubIfd(entries));
}

describe('resolveMediaTimeline', () => {
  it('uses bounded ranges for capture metadata in a large original', async () => {
    const bytes = withLeadingJpegApps(jpeg('2026:09:19 17:42:30','-05:00'));
    const reads:Array<{offset:number;length:number}> = [];
    const input = {mimeType:'image/jpeg' as const,eventStartAt:'2026-09-19T22:00:00.000Z',eventTimezone:'America/Chicago',storedAt:'2026-09-19T22:50:00.000Z',
      source:{size:256*1024**2,read:async (offset:number,length:number) => {
        reads.push({offset,length});
        if (length>4096 || offset>bytes.length) throw new Error('Original tail must not be buffered for EXIF.');
        const range = new Uint8Array(length);
        range.set(bytes.subarray(offset,Math.min(bytes.length,offset+length)));
        return range;
      }}};
    expect((await resolveMediaTimelineSource(input)).capturedAt).toBe('2026-09-19T22:42:30.000Z');
    expect(reads.reduce((sum,read) => sum+read.length,0)).toBeLessThan(128*1024);
    expect(reads.some((read) => read.offset>65_536)).toBe(true);
    expect(await resolveMediaTimelineSource({...input,mimeType:'image/dng'})).toMatchObject({capturedAt:null,timelineAt:input.storedAt});
  });
  it('applies the same event window to valid metadata beyond the old scan ceiling', () => {
    expect(timeline({ bytes: withLeadingJpegApps(jpeg('2026:09:19 17:42:30', '-05:00')) })).toEqual({
      capturedAt: '2026-09-19T22:42:30.000Z', timelineAt: '2026-09-19T22:42:30.000Z', timelineSource: 'capture',
    });
    expect(timeline({ bytes: withLeadingJpegApps(jpeg('2026:09:17 17:42:30', '-05:00')) }).timelineSource).toBe('received');
  });

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

  it('falls back for an unparsable offset', () => {
    expect(timeline({ bytes: jpeg('2026:09:19 17:42:30', 'not-an-offset') })).toEqual({
      capturedAt: null,
      timelineAt: '2026-09-19T22:50:00.000Z',
      timelineSource: 'received',
    });
  });

  it('falls back for an out-of-range offset hour or minute', () => {
    expect(timeline({ bytes: jpeg('2026:09:19 17:42:30', '+25:00') })).toEqual({
      capturedAt: null,
      timelineAt: '2026-09-19T22:50:00.000Z',
      timelineSource: 'received',
    });
    expect(timeline({ bytes: jpeg('2026:09:19 17:42:30', '+05:60') })).toEqual({
      capturedAt: null,
      timelineAt: '2026-09-19T22:50:00.000Z',
      timelineSource: 'received',
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

import { describe, expect, it } from 'vitest';

import type { ManagerGalleryMediaView } from '../../shared/contracts';
import {
  buildMoments,
  formatMomentHeading,
  galleryPhotoTitle,
  mosaicPlacement,
  mosaicStyleVars,
} from '../../src/features/gallery/gallery-timeline';

function photo(id: string, timelineAt: string): ManagerGalleryMediaView {
  return {
    id,
    originalFilename: `${id}.jpg`,
    guestName: 'Jose',
    caption: null,
    publicationStatus: 'unpublished',
    previewAvailable: false,
    width: null,
    height: null,
    receivedAt: timelineAt,
    timelineAt,
    timelineSource: 'received',
    isFavorite: false,
  };
}

describe('buildMoments', () => {
  it('keeps a continuous run inside one moment across a local midnight', () => {
    const photos = [
      photo('a', '2026-08-16T04:30:00.000Z'),
      photo('b', '2026-08-16T04:59:00.000Z'),
      photo('c', '2026-08-16T05:10:00.000Z'),
    ];

    expect(buildMoments(photos)).toEqual([{
      key: 'a',
      photos,
      startAt: '2026-08-16T04:30:00.000Z',
      endAt: '2026-08-16T05:10:00.000Z',
    }]);
  });

  it('splits into a new moment only when the gap exceeds 45 minutes', () => {
    const photos = [
      photo('a', '2026-08-16T04:30:00.000Z'),
      photo('b', '2026-08-16T05:15:00.000Z'), // exactly 45 minutes: same moment
      photo('c', '2026-08-16T06:00:01.000Z'), // 45m 1s later: new moment
      photo('d', '2026-08-16T06:01:00.000Z'),
    ];

    const moments = buildMoments(photos);
    expect(moments.map((moment) => moment.key)).toEqual(['a', 'c']);
    expect(moments[0]?.photos.map((item) => item.id)).toEqual(['a', 'b']);
    expect(moments[1]?.photos.map((item) => item.id)).toEqual(['c', 'd']);
  });

  it('recomputes derived moments without reordering when a page appends', () => {
    const firstPage = [
      photo('a', '2026-08-16T04:30:00.000Z'),
      photo('b', '2026-08-16T04:45:00.000Z'),
    ];
    const appended = [
      ...firstPage,
      photo('c', '2026-08-16T05:00:00.000Z'),
      photo('d', '2026-08-16T05:46:00.000Z'),
    ];

    const moments = buildMoments(appended);
    expect(moments).toHaveLength(2);
    expect(moments[0]?.photos.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moments[0]?.endAt).toBe('2026-08-16T05:00:00.000Z');
    expect(moments[1]?.photos.map((item) => item.id)).toEqual(['d']);
  });
});

describe('galleryPhotoTitle', () => {
  it('prefers the caption and falls back to the filename', () => {
    expect(galleryPhotoTitle(photo('a', '2026-08-15T22:42:00.000Z'))).toBe('a.jpg');
    expect(galleryPhotoTitle({
      ...photo('a', '2026-08-15T22:42:00.000Z'),
      caption: 'First dance',
    })).toBe('First dance');
  });
});

describe('formatMomentHeading', () => {
  const zone = 'America/Chicago';

  it('formats a same-day range with one shared meridiem', () => {
    expect(formatMomentHeading({
      key: 'a',
      photos: [photo('a', '2026-08-15T22:42:00.000Z'), photo('b', '2026-08-15T23:18:00.000Z')],
      startAt: '2026-08-15T22:42:00.000Z',
      endAt: '2026-08-15T23:18:00.000Z',
    }, zone)).toBe('Saturday, August 15 · 5:42–6:18 PM');
  });

  it('formats a cross-date range with both full times', () => {
    expect(formatMomentHeading({
      key: 'a',
      photos: [photo('a', '2026-08-16T04:48:00.000Z'), photo('b', '2026-08-16T05:24:00.000Z')],
      startAt: '2026-08-16T04:48:00.000Z',
      endAt: '2026-08-16T05:24:00.000Z',
    }, zone)).toBe('Saturday, August 15, 11:48 PM–Sunday, August 16, 12:24 AM');
  });

  it('formats a one-photo moment with its single time', () => {
    expect(formatMomentHeading({
      key: 'a',
      photos: [photo('a', '2026-08-16T00:06:00.000Z')],
      startAt: '2026-08-16T00:06:00.000Z',
      endAt: '2026-08-16T00:06:00.000Z',
    }, zone)).toBe('Saturday, August 15 · 7:06 PM');
  });

  it('keeps both meridiem markers when the range crosses noon', () => {
    expect(formatMomentHeading({
      key: 'a',
      photos: [photo('a', '2026-08-15T16:59:00.000Z'), photo('b', '2026-08-15T17:05:00.000Z')],
      startAt: '2026-08-15T16:59:00.000Z',
      endAt: '2026-08-15T17:05:00.000Z',
    }, zone)).toBe('Saturday, August 15 · 11:59 AM–12:05 PM');
  });
});

describe('mosaicPlacement', () => {
  it('applies the exact span pattern for two columns', () => {
    expect(mosaicPlacement(1, 2)).toEqual({ columnSpan: 2, rowSpan: 1 });
    expect(mosaicPlacement(6, 2)).toEqual({ columnSpan: 2, rowSpan: 1 });
    expect(mosaicPlacement(2, 2)).toEqual({ columnSpan: 1, rowSpan: 1 });
  });

  it('applies the exact span pattern for three columns', () => {
    expect(mosaicPlacement(1, 3)).toEqual({ columnSpan: 2, rowSpan: 2 });
    expect(mosaicPlacement(7, 3)).toEqual({ columnSpan: 2, rowSpan: 1 });
    expect(mosaicPlacement(2, 3)).toEqual({ columnSpan: 1, rowSpan: 1 });
  });

  it('applies the exact span pattern for four columns', () => {
    expect(mosaicPlacement(1, 4)).toEqual({ columnSpan: 2, rowSpan: 2 });
    expect(mosaicPlacement(2, 4)).toEqual({ columnSpan: 2, rowSpan: 1 });
    expect(mosaicPlacement(3, 4)).toEqual({ columnSpan: 1, rowSpan: 1 });
  });

  it('never restarts the span pattern past position eight', () => {
    for (const columns of [2, 3, 4] as const) {
      for (const position of [9, 10, 20, 48]) {
        expect(mosaicPlacement(position, columns)).toEqual({ columnSpan: 1, rowSpan: 1 });
      }
    }
  });

  it('emits the span variables for every breakpoint', () => {
    expect(mosaicStyleVars(1)).toEqual({
      '--gallery-col-span-2': 2,
      '--gallery-row-span-2': 1,
      '--gallery-col-span-3': 2,
      '--gallery-row-span-3': 2,
      '--gallery-col-span-4': 2,
      '--gallery-row-span-4': 2,
    });
    expect(mosaicStyleVars(9)).toEqual({
      '--gallery-col-span-2': 1,
      '--gallery-row-span-2': 1,
      '--gallery-col-span-3': 1,
      '--gallery-row-span-3': 1,
      '--gallery-col-span-4': 1,
      '--gallery-row-span-4': 1,
    });
  });
});

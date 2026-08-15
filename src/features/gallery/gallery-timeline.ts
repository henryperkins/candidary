import type { ManagerGalleryMediaView } from '../../../shared/contracts';

export const MOMENT_GAP_MINUTES = 45;

export interface GalleryMoment {
  key: string;
  photos: ManagerGalleryMediaView[];
  startAt: string;
  endAt: string;
}

/**
 * Groups the ordered chronological stream into unnamed derived moments. A new
 * moment begins only when the gap from the previous result exceeds 45 minutes;
 * a local midnight never splits a continuous run, so the grouping is recomputed
 * over the active result set and never stored.
 */
export function buildMoments(photos: readonly ManagerGalleryMediaView[]): GalleryMoment[] {
  const moments: GalleryMoment[] = [];
  const gapMs = MOMENT_GAP_MINUTES * 60_000;
  for (const photo of photos) {
    const current = moments[moments.length - 1];
    const gap = current
      ? Date.parse(photo.timelineAt) - Date.parse(current.endAt)
      : Number.POSITIVE_INFINITY;
    if (current && gap <= gapMs) {
      current.photos.push(photo);
      current.endAt = photo.timelineAt;
    } else {
      moments.push({
        key: photo.id,
        photos: [photo],
        startAt: photo.timelineAt,
        endAt: photo.timelineAt,
      });
    }
  }
  return moments;
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function timeRange(startTime: string, endTime: string): string {
  const suffix = / (AM|PM)$/u.exec(endTime)?.[1];
  if (suffix && startTime.endsWith(` ${suffix}`)) {
    return `${startTime.slice(0, -(suffix.length + 1))}–${endTime}`;
  }
  return `${startTime}–${endTime}`;
}

/**
 * Factual event-local time language only: a one-photo moment names one time, a
 * same-day moment shares one meridiem when it can, and a cross-midnight moment
 * names both dates. No guessed labels such as "Ceremony" or "Dance floor."
 */
export function formatMomentHeading(moment: GalleryMoment, timeZone: string): string {
  const date = dateFormatter(timeZone);
  const time = timeFormatter(timeZone);
  const startDate = date.format(new Date(moment.startAt));
  const endDate = date.format(new Date(moment.endAt));
  const startTime = time.format(new Date(moment.startAt));
  const endTime = time.format(new Date(moment.endAt));
  if (moment.photos.length === 1) return `${startDate} · ${startTime}`;
  if (startDate === endDate) return `${startDate} · ${timeRange(startTime, endTime)}`;
  return `${startDate}, ${startTime}–${endDate}, ${endTime}`;
}

export type MosaicColumnCount = 2 | 3 | 4;

export interface MosaicPlacement {
  columnSpan: number;
  rowSpan: number;
}

const SPAN_PATTERNS: Record<MosaicColumnCount, Readonly<Record<number, MosaicPlacement>>> = {
  2: {
    1: { columnSpan: 2, rowSpan: 1 },
    6: { columnSpan: 2, rowSpan: 1 },
  },
  3: {
    1: { columnSpan: 2, rowSpan: 2 },
    7: { columnSpan: 2, rowSpan: 1 },
  },
  4: {
    1: { columnSpan: 2, rowSpan: 2 },
    2: { columnSpan: 2, rowSpan: 1 },
  },
};

export function mosaicPlacement(position: number, columns: MosaicColumnCount): MosaicPlacement {
  if (position > 8) return { columnSpan: 1, rowSpan: 1 };
  return SPAN_PATTERNS[columns][position] ?? { columnSpan: 1, rowSpan: 1 };
}

/** One span value per breakpoint; the stylesheet's media queries choose which applies. */
export function mosaicStyleVars(position: number): Record<string, number> {
  const variables: Record<string, number> = {};
  for (const columns of [2, 3, 4] as const) {
    const placement = mosaicPlacement(position, columns);
    variables[`--gallery-col-span-${columns}`] = placement.columnSpan;
    variables[`--gallery-row-span-${columns}`] = placement.rowSpan;
  }
  return variables;
}

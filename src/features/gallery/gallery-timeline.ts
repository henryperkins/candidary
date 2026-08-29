import type { ManagerGalleryMediaView } from '../../../shared/contracts';

export const MOMENT_GAP_MINUTES = 45;
/**
 * A reception never pauses 45 minutes, so gap alone let a whole evening collapse into
 * one group: "Show more photos" became an 800-tile action, and the authored mosaic
 * rhythm — which only shapes the first eight positions — applied once to the entire
 * night. A ceiling turns that into a readable run of moments, each with its own real
 * time range and its own composition.
 */
export const MOMENT_PHOTO_LIMIT = 60;

export interface GalleryMoment {
  key: string;
  photos: ManagerGalleryMediaView[];
  startAt: string;
  endAt: string;
}

/**
 * What a photo is called wherever the host sees it named. The caption is guest prose and the
 * filename is the fallback, so this must never return an empty string: it becomes an `alt`, an
 * accessible name, and the immersive viewer's dialog name, and a blank caption that reached the
 * database before intake trimmed them would otherwise leave all three unnamed.
 */
export function galleryPhotoTitle(
  photo: Pick<ManagerGalleryMediaView, 'caption' | 'originalFilename'>,
): string {
  const caption = photo.caption?.trim();
  return caption ? caption : photo.originalFilename;
}

/**
 * Groups the ordered stream into unnamed derived moments. A new moment begins when the
 * step from the previous result exceeds 45 minutes, or when the current one is full;
 * a local midnight never splits a continuous run, so the grouping is recomputed over
 * the active result set and never stored.
 *
 * The stream may run newest-first or earliest-first, so the step is a *distance*, not a
 * difference — a moment is a run of photos close together in time, whichever way the
 * host is reading. `startAt` and `endAt` are therefore the moment's earliest and latest
 * instants rather than its first and last arrivals, which is what the heading needs.
 */
export function buildMoments(photos: readonly ManagerGalleryMediaView[]): GalleryMoment[] {
  const moments: GalleryMoment[] = [];
  const gapMs = MOMENT_GAP_MINUTES * 60_000;
  let previousAt: number | null = null;
  for (const photo of photos) {
    const at = Date.parse(photo.timelineAt);
    const current = moments[moments.length - 1];
    const continues = current !== undefined
      && previousAt !== null
      && Math.abs(at - previousAt) <= gapMs
      && current.photos.length < MOMENT_PHOTO_LIMIT;
    if (continues && current) {
      current.photos.push(photo);
      if (at < Date.parse(current.startAt)) current.startAt = photo.timelineAt;
      if (at > Date.parse(current.endAt)) current.endAt = photo.timelineAt;
    } else {
      moments.push({
        key: photo.id,
        photos: [photo],
        startAt: photo.timelineAt,
        endAt: photo.timelineAt,
      });
    }
    previousAt = at;
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
  if (startDate === endDate) {
    return `${startDate} · ${startTime === endTime ? startTime : timeRange(startTime, endTime)}`;
  }
  return `${startDate}, ${startTime}–${endDate}, ${endTime}`;
}

export type MosaicColumnCount = 2 | 3 | 4;

export interface MosaicPlacement {
  columnSpan: number;
  rowSpan: number;
}

const SPAN_PATTERNS: Record<MosaicColumnCount, Readonly<Record<number, MosaicPlacement>>> = {
  2: {
    // Two rows, not one. The hero stays square while every later photo keeps the same
    // supporting weight; an incomplete final row is preferable to inventing a second feature.
    1: { columnSpan: 2, rowSpan: 2 },
  },
  3: {
    1: { columnSpan: 2, rowSpan: 2 },
  },
  4: {
    1: { columnSpan: 2, rowSpan: 2 },
  },
};

export function mosaicPlacement(
  position: number,
  columns: MosaicColumnCount,
  firstMoment = true,
): MosaicPlacement {
  if (!firstMoment || position > 8) return { columnSpan: 1, rowSpan: 1 };
  return SPAN_PATTERNS[columns][position] ?? { columnSpan: 1, rowSpan: 1 };
}

/** One span value per breakpoint; the stylesheet's media queries choose which applies. */
export function mosaicStyleVars(position: number, firstMoment = true): Record<string, number> {
  const variables: Record<string, number> = {};
  for (const columns of [2, 3, 4] as const) {
    const placement = mosaicPlacement(position, columns, firstMoment);
    variables[`--gallery-col-span-${columns}`] = placement.columnSpan;
    variables[`--gallery-row-span-${columns}`] = placement.rowSpan;
  }
  return variables;
}

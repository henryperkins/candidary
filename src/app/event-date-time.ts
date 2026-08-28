import { isCalendarDate, isIanaTimeZone } from '../../shared/event-time';

/**
 * One answer, for the whole application, to "what does this instant say".
 *
 * Every surface that shows a host a date is showing them something about *their
 * event* — when a recovery deadline passes, which collection an export froze,
 * when retention ends — and every one of those has to be read in the event's own
 * time zone. A browser rendering `2026-09-19T05:00:00Z` in its own locale is
 * telling a host in another zone about a different day, and for a deadline that
 * is not a cosmetic difference.
 *
 * Three rules hold everywhere here:
 *
 *  - a calendar date is never interpreted as an instant. `2026-09-19` is a day,
 *    not midnight UTC, and parsing it into a `Date` is exactly how it becomes the
 *    18th for half the world;
 *  - an instant always requires an explicit IANA zone. There is no default and no
 *    fallback to the machine zone: a caller that cannot supply the event's zone
 *    gets `null` and renders the unavailable literal, which is honest, rather
 *    than a plausible time in the wrong place;
 *  - invalid input returns `null` rather than throwing or rendering `Invalid
 *    Date`. The caller renders **Date unavailable** or **Time unavailable** as
 *    plain text with no `<time>` element, because there is no machine-readable
 *    value to carry.
 *
 * The locale is fixed at `en-US` deliberately. These are not localized surfaces
 * yet, and letting the runtime locale decide would make two hosts disagree about
 * what the same deadline said.
 */

const LOCALE = 'en-US';
const EXPLICIT_OFFSET_INSTANT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;

function validInstant(iso: string, timeZone: string): Date | null {
  if (!isIanaTimeZone(timeZone)) return null;
  const match = EXPLICIT_OFFSET_INSTANT.exec(iso);
  if (!match || !isCalendarDate(match[1] ?? '')) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/**
 * A calendar day, formatted as a day.
 *
 * Takes `YYYY-MM-DD` and reads its parts directly rather than constructing a
 * `Date`, so no zone — the browser's or the event's — is involved at all.
 */
export function formatEventDate(
  dateOnly: string,
  presentation: 'long' | 'compact' = 'long',
): string | null {
  if (!isCalendarDate(dateOnly)) return null;
  const [year, month, day] = dateOnly.split('-').map(Number) as [number, number, number];
  const options: Intl.DateTimeFormatOptions = presentation === 'compact'
    ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat(LOCALE, options).format(Date.UTC(year, month - 1, day));
}

/** An instant, as a date and time in the event's zone. */
export function formatEventDateTime(iso: string, eventTimezone: string): string | null {
  const instant = validInstant(iso, eventTimezone);
  if (!instant) return null;
  return new Intl.DateTimeFormat(LOCALE, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: eventTimezone,
  }).format(instant);
}

/** An instant, as a date in the event's zone. No clock time. */
export function formatEventDay(iso: string, eventTimezone: string): string | null {
  const instant = validInstant(iso, eventTimezone);
  if (!instant) return null;
  return new Intl.DateTimeFormat(LOCALE, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: eventTimezone,
  }).format(instant);
}

/**
 * A span between two instants, in the event's zone.
 *
 * When both endpoints render identically — the same minute, or two instants a few
 * seconds apart — one endpoint is emitted rather than the same string twice with
 * a dash between it. `null` if either endpoint is unreadable, because half a
 * range is not a range.
 */
export function formatEventTimeRange(
  startIso: string,
  endIso: string,
  eventTimezone: string,
): string | null {
  const start = formatEventDateTime(startIso, eventTimezone);
  const end = formatEventDateTime(endIso, eventTimezone);
  if (start === null || end === null) return null;
  return start === end ? start : `${start} – ${end}`;
}

/**
 * When something stops being available.
 *
 * The same formatter as any other instant; the separate name exists because the
 * *source* matters and is easy to get wrong. Recently deleted reads the server's
 * `restoreUntil`, an export's Prepared line reads the immutable `snapshotAt` and
 * never the diagnostic `createdAt`, and retention reads `purgeAfter`.
 */
export function formatRetentionDate(iso: string, eventTimezone: string): string | null {
  return formatEventDateTime(iso, eventTimezone);
}

/**
 * How the two halves of a rendered value travel together.
 *
 * `value` is what a person reads; `dateTime` is the machine-readable source, and
 * it is present only when there is one — so a caller can write
 * `dateTime ? <time dateTime={dateTime}>{value}</time> : value` and never emit a
 * `<time>` element with nothing semantic in it.
 */
export interface EventTimeDisplay {
  value: string;
  dateTime: string | null;
}

export const DATE_UNAVAILABLE = 'Date unavailable';
export const TIME_UNAVAILABLE = 'Time unavailable';

export function eventDateDisplay(dateOnly: string): EventTimeDisplay {
  const value = formatEventDate(dateOnly);
  return value === null
    ? { value: DATE_UNAVAILABLE, dateTime: null }
    : { value, dateTime: dateOnly };
}

export function eventDateTimeDisplay(iso: string, eventTimezone: string): EventTimeDisplay {
  const value = formatEventDateTime(iso, eventTimezone);
  return value === null
    ? { value: TIME_UNAVAILABLE, dateTime: null }
    : { value, dateTime: iso };
}

// Event deadlines are chosen as a calendar date in the host's event time zone
// and stored as one absolute instant. Nothing here may consult the host
// machine's zone: the Worker, the host browser, and the guest browser all run
// somewhere else, and only the event's own zone decides when the day ends.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
// Rejects fixed-offset identifiers such as "+05:30", which modern engines
// accept but which are not IANA zones and would not track a future DST rule.
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

// Wide enough that one end is always before and the other always after the
// target local midnight, for every offset from -12:00 to +14:00.
const WINDOW_MS = 26 * 60 * 60 * 1000;
// Finer than any modern UTC-offset transition, so no re-gained slice of a local
// day can hide between two probes.
const PROBE_STEP_MS = 10 * 60 * 1000;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

export function isIanaTimeZone(value: string): boolean {
  if (!IANA_SHAPE.test(value)) return false;
  try {
    formatterFor(value).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the canonical IANA spelling, so a host who types "america/chicago"
 * stores "America/Chicago" and every later export reads the same way.
 */
export function canonicalTimeZone(value: string): string | null {
  if (!isIanaTimeZone(value)) return null;
  return formatterFor(value).resolvedOptions().timeZone;
}

function requireFormatter(timeZone: string): Intl.DateTimeFormat {
  if (!isIanaTimeZone(timeZone)) {
    throw new RangeError('Unknown event time zone.');
  }
  return formatterFor(timeZone);
}

function isoDateOf(date: CalendarDate): string {
  return [
    String(date.year).padStart(4, '0'),
    String(date.month).padStart(2, '0'),
    String(date.day).padStart(2, '0'),
  ].join('-');
}

function zonedDate(formatter: Intl.DateTimeFormat, instantMs: number): CalendarDate {
  const parts = formatter.formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new RangeError(`Formatted date is missing its ${type}.`);
    return Number(part.value);
  };
  return { year: read('year'), month: read('month'), day: read('day') };
}

function parseCalendarDate(dateOnly: string): CalendarDate {
  const match = DATE_ONLY.exec(dateOnly);
  if (!match) {
    throw new RangeError('Choose a valid calendar date in YYYY-MM-DD form.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Date.UTC silently rolls February 30th into March, so the only way to reject
  // an impossible date is to build it and check that it came back unchanged.
  const rebuilt = new Date(Date.UTC(year, month - 1, day));
  if (
    rebuilt.getUTCFullYear() !== year
    || rebuilt.getUTCMonth() + 1 !== month
    || rebuilt.getUTCDate() !== day
  ) {
    throw new RangeError('That calendar date does not exist.');
  }
  return { year, month, day };
}

function nextCalendarDate(date: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day) + 24 * 60 * 60 * 1000);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

/**
 * The last millisecond of `dateOnly` as lived in `timeZone`, as an absolute
 * instant. An event stays open through this instant and closes on the next one.
 *
 * The local date is deliberately not assumed to increase with absolute time. A
 * zone that ends DST at 00:00 rewinds across midnight and hands the same
 * calendar day back for another hour, so this looks for the *last* place the
 * local date leaves the target day, then bisects that probe window down to the
 * exact millisecond. Zones that skip midnight going the other way fall out of
 * the same search for free.
 */
export function endOfLocalDate(dateOnly: string, timeZone: string): string {
  const formatter = requireFormatter(timeZone);
  const nextIso = isoDateOf(nextCalendarDate(parseCalendarDate(dateOnly)));
  const next = parseCalendarDate(nextIso);
  const anchor = Date.UTC(next.year, next.month - 1, next.day);

  const start = anchor - WINDOW_MS;
  const end = anchor + WINDOW_MS;

  let previousIso = isoDateOf(zonedDate(formatter, start));
  let lastCrossing: number | null = null;
  for (let probe = start + PROBE_STEP_MS; probe <= end; probe += PROBE_STEP_MS) {
    const currentIso = isoDateOf(zonedDate(formatter, probe));
    if (previousIso < nextIso && currentIso >= nextIso) {
      lastCrossing = probe - PROBE_STEP_MS;
    }
    previousIso = currentIso;
  }
  if (lastCrossing === null) {
    throw new RangeError('Could not place that date in the event time zone.');
  }

  let low = lastCrossing;
  let high = lastCrossing + PROBE_STEP_MS;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (isoDateOf(zonedDate(formatter, middle)) >= nextIso) high = middle;
    else low = middle + 1;
  }
  return new Date(low - 1).toISOString();
}

/**
 * The calendar date an instant falls on in the event's own zone. Views use this
 * instead of handing an absolute timestamp to a guest browser, which would
 * re-render the host's deadline in whatever zone the guest is standing in.
 */
export function localDateForInstant(instant: string, timeZone: string): string {
  const formatter = requireFormatter(timeZone);
  const instantMs = Date.parse(instant);
  if (!Number.isFinite(instantMs)) {
    throw new RangeError('That timestamp could not be read.');
  }
  return isoDateOf(zonedDate(formatter, instantMs));
}

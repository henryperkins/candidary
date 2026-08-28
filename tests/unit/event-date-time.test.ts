import { describe, expect, it } from 'vitest';

import {
  DATE_UNAVAILABLE,
  TIME_UNAVAILABLE,
  eventDateDisplay,
  eventDateTimeDisplay,
  formatEventDate,
  formatEventDateTime,
  formatEventDay,
  formatEventTimeRange,
  formatRetentionDate,
} from '../../src/app/event-date-time';

/**
 * Runs `read` once under each machine zone and reports both what came back and
 * the UTC offsets the process itself actually moved through. The second half
 * matters: without it, a single stable result could be a formatter that never
 * had a chance to disagree.
 *
 * The locale is fixed at `en-US` inside the module, so the exact rendered
 * strings below are assertable rather than whatever the runtime felt like.
 */
function acrossMachineZones(
  machineZones: readonly string[],
  read: () => string | null,
): { results: Set<string | null>; machineOffsets: Set<number> } {
  const original = process.env.TZ;
  const results = new Set<string | null>();
  const machineOffsets = new Set<number>();
  try {
    for (const machineZone of machineZones) {
      process.env.TZ = machineZone;
      machineOffsets.add(new Date(2026, 8, 19).getTimezoneOffset());
      results.add(read());
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  return { results, machineOffsets };
}

// One end of the world to the other: +14:00, -10:00, +00:00, +05:30.
const MACHINE_ZONES = ['Pacific/Kiritimati', 'Pacific/Honolulu', 'UTC', 'Asia/Kolkata'] as const;

describe('calendar dates render as days', () => {
  it.each<[string, string]>([
    ['2026-09-19', 'September 19, 2026'],
    ['2026-01-01', 'January 1, 2026'],
    ['2026-12-31', 'December 31, 2026'],
    ['2024-02-29', 'February 29, 2024'],
  ])('formats %s as %s', (dateOnly, expected) => {
    expect(formatEventDate(dateOnly)).toBe(expected);
  });

  it('renders the same day whatever zone the process itself is in', () => {
    // A host reading their own event date must not be told a different day
    // because the browser happens to be standing somewhere else. Building a
    // Date from `2026-09-19` is exactly how it becomes the 18th for half the
    // world, so this has to hold from +14:00 through -10:00.
    const { results, machineOffsets } = acrossMachineZones(
      MACHINE_ZONES,
      () => formatEventDate('2026-09-19'),
    );
    expect(machineOffsets.size).toBe(MACHINE_ZONES.length);
    expect([...results]).toEqual(['September 19, 2026']);
  });

  it('holds at the year boundary, where a slipped day is also a slipped year', () => {
    const { results, machineOffsets } = acrossMachineZones(
      MACHINE_ZONES,
      () => formatEventDate('2026-01-01'),
    );
    expect(machineOffsets.size).toBe(MACHINE_ZONES.length);
    expect([...results]).toEqual(['January 1, 2026']);
  });

  it.each<string>([
    // Impossible calendar values, not merely badly shaped ones.
    '2026-02-30',
    '2026-02-29',
    '2026-09-31',
    '2026-13-01',
    '2026-00-10',
    '2026-09-00',
    // Badly shaped.
    '20260919',
    '2026-9-19',
    '2026-09-1',
    '',
    'not-a-date',
    'September 19, 2026',
    // An instant is not a calendar date; it goes through formatEventDateTime.
    '2026-09-19T00:00:00.000Z',
  ])('returns null for the calendar value %j', (value) => {
    expect(formatEventDate(value)).toBeNull();
  });

  it('keeps a calendar date and an instant on separate entry points', () => {
    // The two functions exist because the inputs are different kinds of thing.
    // Handing a calendar date to the instant formatter reads it as UTC midnight,
    // which in a negative-offset zone is the evening before — the whole reason
    // formatEventDate never constructs a Date at all.
    expect(formatEventDate('2026-09-19')).toBe('September 19, 2026');
    expect(formatEventDay('2026-09-19', 'America/Chicago')).toBe('September 18, 2026');
  });
});

describe('instants render in the event zone', () => {
  it.each<[string, string, string]>([
    ['UTC', '2026-09-19T22:00:00.000Z', 'September 19, 2026 at 10:00 PM UTC'],
    ['America/Chicago', '2026-09-19T22:00:00.000Z', 'September 19, 2026 at 5:00 PM CDT'],
    ['Asia/Kolkata', '2026-09-19T22:00:00.000Z', 'September 20, 2026 at 3:30 AM GMT+5:30'],
    ['Pacific/Auckland', '2026-09-19T22:00:00.000Z', 'September 20, 2026 at 10:00 AM GMT+12'],
    // Offsets that are not whole hours, including a quarter-hour one, because a
    // formatter that rounded to the hour would still look right in Chicago.
    ['Australia/Lord_Howe', '2026-09-19T22:00:00.000Z', 'September 20, 2026 at 8:30 AM GMT+10:30'],
    ['Pacific/Chatham', '2026-09-19T22:00:00.000Z', 'September 20, 2026 at 10:45 AM GMT+12:45'],
  ])('formats %s / %s as %s', (eventTimezone, iso, expected) => {
    expect(formatEventDateTime(iso, eventTimezone)).toBe(expected);
  });

  it('reads an instant written with an offset as the same instant', () => {
    // `restoreUntil`, `snapshotAt`, and `purgeAfter` all arrive as UTC today,
    // but the contract is "an ISO instant" — and an instant carrying its own
    // offset is the same point on the timeline, not a different one.
    expect(formatEventDateTime('2026-09-19T17:00:00-05:00', 'America/Chicago'))
      .toBe(formatEventDateTime('2026-09-19T22:00:00.000Z', 'America/Chicago'));
    expect(formatEventDateTime('2026-09-19T17:00:00-05:00', 'Asia/Kolkata'))
      .toBe('September 20, 2026 at 3:30 AM GMT+5:30');
  });

  it('reads the event zone, not UTC, when the two disagree about the day', () => {
    // 02:30 UTC on the 20th is still the evening of the 19th in Chicago. A
    // recovery deadline shown as "September 20" to a host whose event zone says
    // the 19th is not a cosmetic difference.
    const iso = '2026-09-20T02:30:00.000Z';
    expect(formatEventDateTime(iso, 'America/Chicago'))
      .toBe('September 19, 2026 at 9:30 PM CDT');
    expect(formatEventDay(iso, 'America/Chicago')).toBe('September 19, 2026');
    expect(formatEventDay(iso, 'UTC')).toBe('September 20, 2026');
    expect(formatEventDay(iso, 'Pacific/Auckland')).toBe('September 20, 2026');
  });

  it.each<[string, string, string]>([
    ['UTC', '2026-09-19T22:00:00.000Z', 'September 19, 2026'],
    ['America/Chicago', '2026-09-19T22:00:00.000Z', 'September 19, 2026'],
    ['Asia/Kolkata', '2026-07-30T18:29:59.999Z', 'July 30, 2026'],
    // The last local millisecond of November 1st in Chicago — the fall-back day
    // is 25 hours long, and its final instant is still that day.
    ['America/Chicago', '2026-11-02T05:59:59.999Z', 'November 1, 2026'],
  ])('formats the %s day of %s as %s', (eventTimezone, iso, expected) => {
    expect(formatEventDay(iso, eventTimezone)).toBe(expected);
  });

  it('renders the same instant whatever zone the process itself is in', () => {
    const { results, machineOffsets } = acrossMachineZones(
      MACHINE_ZONES,
      () => formatEventDateTime('2026-09-19T22:00:00.000Z', 'America/Chicago'),
    );
    expect(machineOffsets.size).toBe(MACHINE_ZONES.length);
    expect([...results]).toEqual(['September 19, 2026 at 5:00 PM CDT']);
  });

  it('crosses a spring-forward boundary without inventing the skipped hour', () => {
    // Chicago jumps 02:00 to 03:00 on 2026-03-08. One minute of absolute time
    // moves the wall clock by an hour and swaps the abbreviation, and both
    // sides have to say so.
    expect(formatEventDateTime('2026-03-08T07:59:00.000Z', 'America/Chicago'))
      .toBe('March 8, 2026 at 1:59 AM CST');
    expect(formatEventDateTime('2026-03-08T08:00:00.000Z', 'America/Chicago'))
      .toBe('March 8, 2026 at 3:00 AM CDT');
    expect(formatEventDay('2026-03-08T07:59:00.000Z', 'America/Chicago'))
      .toBe('March 8, 2026');
    expect(formatEventDay('2026-03-08T08:00:00.000Z', 'America/Chicago'))
      .toBe('March 8, 2026');
  });

  it('distinguishes the two occurrences of a fall-back hour', () => {
    // 01:30 happens twice in Chicago on 2026-11-01, an hour of absolute time
    // apart. Only the zone abbreviation separates them, so it has to be there.
    const first = formatEventDateTime('2026-11-01T06:30:00.000Z', 'America/Chicago');
    const second = formatEventDateTime('2026-11-01T07:30:00.000Z', 'America/Chicago');
    expect(first).toBe('November 1, 2026 at 1:30 AM CDT');
    expect(second).toBe('November 1, 2026 at 1:30 AM CST');
    expect(first).not.toBe(second);
  });

  it('crosses a southern-hemisphere DST boundary, where the seasons run backwards', () => {
    // Auckland ends DST on 2026-04-05 and starts it on 2026-09-27 — the
    // opposite months to Chicago, and an offset that moves between +13 and +12
    // rather than a named abbreviation. Nothing about the rendering may be
    // specific to the northern half of the year.
    expect(formatEventDateTime('2026-04-04T13:00:00.000Z', 'Pacific/Auckland'))
      .toBe('April 5, 2026 at 2:00 AM GMT+13');
    expect(formatEventDateTime('2026-04-04T14:00:00.000Z', 'Pacific/Auckland'))
      .toBe('April 5, 2026 at 2:00 AM GMT+12');
    expect(formatEventDateTime('2026-09-26T13:59:00.000Z', 'Pacific/Auckland'))
      .toBe('September 27, 2026 at 1:59 AM GMT+12');
    expect(formatEventDateTime('2026-09-26T14:00:00.000Z', 'Pacific/Auckland'))
      .toBe('September 27, 2026 at 3:00 AM GMT+13');
    // The skipped hour and the repeated one both stay on their own local day.
    expect(formatEventDay('2026-09-26T13:59:00.000Z', 'Pacific/Auckland'))
      .toBe('September 27, 2026');
    expect(formatEventDay('2026-09-26T14:00:00.000Z', 'Pacific/Auckland'))
      .toBe('September 27, 2026');
  });

  it('refuses an unreadable zone rather than falling back to the machine one', () => {
    // The machine is standing in exactly the zone the caller failed to supply,
    // so a fallback would look completely correct right here — and would be a
    // plausible time in the wrong place everywhere else. There is no default.
    const iso = '2026-09-19T22:00:00.000Z';
    const { results, machineOffsets } = acrossMachineZones(
      ['America/Chicago', 'UTC'],
      () => formatEventDateTime(iso, ''),
    );
    expect(machineOffsets.size).toBe(2);
    expect([...results]).toEqual([null]);
  });

  it.each<[string, string, () => string | null]>([
    [
      'formatEventDay',
      'September 19, 2026',
      () => formatEventDay('2026-09-20T02:30:00.000Z', 'America/Chicago'),
    ],
    [
      'formatRetentionDate',
      'September 19, 2026 at 9:30 PM CDT',
      () => formatRetentionDate('2026-09-20T02:30:00.000Z', 'America/Chicago'),
    ],
    [
      'formatEventTimeRange',
      'September 19, 2026 at 5:00 PM CDT – September 19, 2026 at 9:30 PM CDT',
      () => formatEventTimeRange(
        '2026-09-19T22:00:00.000Z',
        '2026-09-20T02:30:00.000Z',
        'America/Chicago',
      ),
    ],
    [
      'eventDateTimeDisplay',
      'September 19, 2026 at 9:30 PM CDT',
      () => eventDateTimeDisplay('2026-09-20T02:30:00.000Z', 'America/Chicago').value,
    ],
  ])('keeps %s out of the machine zone', (_name, expected, read) => {
    // `formatEventDay` is the one that matters most: with no clock time and no
    // abbreviation on screen, a value that quietly moved with the process zone
    // would still look like a perfectly ordinary date.
    const { results, machineOffsets } = acrossMachineZones(MACHINE_ZONES, read);
    expect(machineOffsets.size).toBe(MACHINE_ZONES.length);
    expect([...results]).toEqual([expected]);
  });

  it('accepts a zone spelled in any case, as storage canonicalization does', () => {
    expect(formatEventDateTime('2026-09-19T22:00:00.000Z', 'america/chicago'))
      .toBe('September 19, 2026 at 5:00 PM CDT');
  });

  it.each<string>([
    'Central Wedding Time',
    'Not/A_Zone',
    '',
    // Fixed-offset identifiers parse in modern engines but are not IANA zones
    // and would not track a future DST rule, so they are refused here too.
    '+05:30',
    '-06:00',
    'America/Chicago ',
  ])('returns null for the event zone %j', (eventTimezone) => {
    const iso = '2026-09-19T22:00:00.000Z';
    expect(formatEventDateTime(iso, eventTimezone)).toBeNull();
    expect(formatEventDay(iso, eventTimezone)).toBeNull();
    expect(formatRetentionDate(iso, eventTimezone)).toBeNull();
    expect(formatEventTimeRange(iso, '2026-09-20T02:00:00.000Z', eventTimezone)).toBeNull();
  });

  it.each<string>([
    'not-a-timestamp',
    '',
    '   ',
    'yesterday',
    '19/09/2026',
    '2026-13-19T00:00:00.000Z',
    '2026-09-19T25:00:00.000Z',
  ])('returns null for the instant %j', (iso) => {
    expect(formatEventDateTime(iso, 'America/Chicago')).toBeNull();
    expect(formatEventDay(iso, 'America/Chicago')).toBeNull();
    expect(formatRetentionDate(iso, 'America/Chicago')).toBeNull();
  });

  it('returns null when the instant and the zone are both unreadable', () => {
    expect(formatEventDateTime('not-a-timestamp', 'Central Wedding Time')).toBeNull();
  });
});

describe('retention deadlines', () => {
  it('reads a deadline exactly as any other instant in the event zone', () => {
    // Recently deleted reads restoreUntil, an export reads snapshotAt, and
    // retention reads purgeAfter. The separate name is about the source, not a
    // different rendering.
    const iso = '2026-09-19T22:00:00.000Z';
    expect(formatRetentionDate(iso, 'America/Chicago'))
      .toBe('September 19, 2026 at 5:00 PM CDT');
    expect(formatRetentionDate(iso, 'America/Chicago'))
      .toBe(formatEventDateTime(iso, 'America/Chicago'));
  });

  it('renders a deadline that falls on the previous day in the event zone', () => {
    expect(formatRetentionDate('2026-09-20T02:30:00.000Z', 'America/Chicago'))
      .toBe('September 19, 2026 at 9:30 PM CDT');
  });
});

describe('time ranges', () => {
  it('renders two distinct instants as a range', () => {
    expect(formatEventTimeRange(
      '2026-09-19T22:00:00.000Z',
      '2026-09-20T03:00:00.000Z',
      'America/Chicago',
    )).toBe('September 19, 2026 at 5:00 PM CDT – September 19, 2026 at 10:00 PM CDT');
  });

  it('renders a range that crosses midnight in the event zone', () => {
    expect(formatEventTimeRange(
      '2026-09-19T22:00:00.000Z',
      '2026-09-20T06:00:00.000Z',
      'America/Chicago',
    )).toBe('September 19, 2026 at 5:00 PM CDT – September 20, 2026 at 1:00 AM CDT');
  });

  it('emits one endpoint when both ends render identically', () => {
    // Two instants thirty seconds apart are the same minute on a clock that
    // shows minutes, and "5:00 PM – 5:00 PM" says nothing a single 5:00 PM does
    // not.
    expect(formatEventTimeRange(
      '2026-09-19T22:00:00.000Z',
      '2026-09-19T22:00:30.000Z',
      'America/Chicago',
    )).toBe('September 19, 2026 at 5:00 PM CDT');
    expect(formatEventTimeRange(
      '2026-09-19T22:00:00.000Z',
      '2026-09-19T22:00:00.000Z',
      'America/Chicago',
    )).toBe('September 19, 2026 at 5:00 PM CDT');
  });

  it('keeps a repeated fall-back hour as a real range', () => {
    // Both ends read 1:30 AM, but they are an hour of absolute time apart and
    // the abbreviation says so — collapsing them would hide the hour.
    expect(formatEventTimeRange(
      '2026-11-01T06:30:00.000Z',
      '2026-11-01T07:30:00.000Z',
      'America/Chicago',
    )).toBe('November 1, 2026 at 1:30 AM CDT – November 1, 2026 at 1:30 AM CST');
  });

  it('keeps a repeated hour in a zone named only by its offset as a real range', () => {
    // Auckland's fall-back has no CDT/CST to separate the two 2:00 AMs — only
    // GMT+13 and GMT+12 — and that is still enough for two endpoints.
    expect(formatEventTimeRange(
      '2026-04-04T13:00:00.000Z',
      '2026-04-04T14:00:00.000Z',
      'Pacific/Auckland',
    )).toBe('April 5, 2026 at 2:00 AM GMT+13 – April 5, 2026 at 2:00 AM GMT+12');
  });

  it.each<[string, string]>([
    ['not-a-timestamp', '2026-09-20T03:00:00.000Z'],
    ['2026-09-19T22:00:00.000Z', 'not-a-timestamp'],
    ['not-a-timestamp', 'also-not-a-timestamp'],
    ['', ''],
  ])('returns null when an endpoint is unreadable (%j, %j)', (startIso, endIso) => {
    // Half a range is not a range.
    expect(formatEventTimeRange(startIso, endIso, 'America/Chicago')).toBeNull();
  });
});

describe('rendered values carry their machine-readable source', () => {
  it('pairs a formatted calendar date with the value a <time> element can carry', () => {
    expect(eventDateDisplay('2026-09-19')).toEqual({
      value: 'September 19, 2026',
      dateTime: '2026-09-19',
    });
  });

  it.each<string>(['2026-02-30', '20260919', '', 'not-a-date'])(
    'reports %j as unavailable with nothing semantic to carry',
    (value) => {
      // The caller renders this literal as plain text: a <time> element with no
      // dateTime is worse than no element at all.
      expect(eventDateDisplay(value)).toEqual({ value: DATE_UNAVAILABLE, dateTime: null });
    },
  );

  it('pairs a formatted instant with the exact source it was given', () => {
    // The source travels verbatim — the module does not re-serialize it — so a
    // non-canonical but valid ISO string still round-trips into dateTime.
    expect(eventDateTimeDisplay('2026-09-19T22:00:00.000Z', 'America/Chicago')).toEqual({
      value: 'September 19, 2026 at 5:00 PM CDT',
      dateTime: '2026-09-19T22:00:00.000Z',
    });
    expect(eventDateTimeDisplay('2026-09-19T22:00:00Z', 'America/Chicago')).toEqual({
      value: 'September 19, 2026 at 5:00 PM CDT',
      dateTime: '2026-09-19T22:00:00Z',
    });
  });

  it.each<[string, string]>([
    ['not-a-timestamp', 'America/Chicago'],
    ['', 'America/Chicago'],
    // A perfectly good instant with no zone to read it in is still unavailable,
    // rather than a plausible time in the wrong place.
    ['2026-09-19T22:00:00.000Z', 'Central Wedding Time'],
    ['2026-09-19T22:00:00.000Z', ''],
    ['2026-09-19T22:00:00.000Z', '+05:30'],
  ])('reports (%j, %j) as unavailable with nothing semantic to carry', (iso, eventTimezone) => {
    expect(eventDateTimeDisplay(iso, eventTimezone)).toEqual({
      value: TIME_UNAVAILABLE,
      dateTime: null,
    });
  });

  it('keeps the two unavailable literals distinct', () => {
    expect(DATE_UNAVAILABLE).toBe('Date unavailable');
    expect(TIME_UNAVAILABLE).toBe('Time unavailable');
  });
});

import { describe, expect, it } from 'vitest';

import {
  canonicalTimeZone,
  endOfLocalDate,
  instantForLocalDateTime,
  isIanaTimeZone,
  localDateForInstant,
  localTimeForInstant,
} from '../../shared/event-time';

describe('event-local RSVP deadlines', () => {
  it('stores the last local millisecond across spring DST', () => {
    expect(endOfLocalDate('2026-03-08', 'America/Chicago'))
      .toBe('2026-03-09T04:59:59.999Z');
  });

  it('stores the last local millisecond across fall DST', () => {
    expect(endOfLocalDate('2026-11-01', 'America/Chicago'))
      .toBe('2026-11-02T05:59:59.999Z');
  });

  it('rejects invented zones and impossible dates', () => {
    expect(isIanaTimeZone('America/Chicago')).toBe(true);
    expect(isIanaTimeZone('Central Wedding Time')).toBe(false);
    expect(() => endOfLocalDate('2026-02-30', 'America/Chicago')).toThrow();
  });

  it('returns the event-local date on a guest device in another zone', () => {
    expect(localDateForInstant(
      '2026-07-31T04:59:59.999Z',
      'America/Chicago',
    )).toBe('2026-07-30');
    expect(localDateForInstant(
      '2026-07-31T04:59:59.999Z',
      'Pacific/Auckland',
    )).toBe('2026-07-31');
  });

  it.each<[string, string, string]>([
    ['UTC', '2026-07-30', '2026-07-30T23:59:59.999Z'],
    ['America/Chicago', '2026-07-30', '2026-07-31T04:59:59.999Z'],
    ['Asia/Kolkata', '2026-07-30', '2026-07-30T18:29:59.999Z'],
    ['Pacific/Auckland', '2026-07-30', '2026-07-30T11:59:59.999Z'],
    ['America/Chicago', '2024-02-29', '2024-03-01T05:59:59.999Z'],
  ])('closes %s on %s at the right instant', (timeZone, date, expected) => {
    expect(endOfLocalDate(date, timeZone)).toBe(expected);
  });

  it.each<[string, string]>([
    ['UTC', '2026-07-30'],
    ['America/Chicago', '2026-03-08'],
    ['America/Chicago', '2026-11-01'],
    ['Asia/Kolkata', '2026-07-30'],
    ['Pacific/Auckland', '2026-09-27'],
    ['Australia/Lord_Howe', '2026-04-05'],
    // Santiago moves its clock at 24:00, so local midnight itself does not
    // exist on this date. The last millisecond of the day still does.
    ['America/Santiago', '2026-09-06'],
  ])('round-trips %s / %s through the event zone', (timeZone, date) => {
    expect(localDateForInstant(endOfLocalDate(date, timeZone), timeZone)).toBe(date);
  });

  it('leaves one millisecond between the deadline and the next local day', () => {
    const deadline = endOfLocalDate('2026-07-30', 'America/Chicago');
    const nextMillisecond = new Date(Date.parse(deadline) + 1).toISOString();
    expect(localDateForInstant(deadline, 'America/Chicago')).toBe('2026-07-30');
    expect(localDateForInstant(nextMillisecond, 'America/Chicago')).toBe('2026-07-31');
  });

  it.each<[string, boolean]>([
    ['America/Chicago', true],
    ['UTC', true],
    ['Pacific/Auckland', true],
    // Intl matches zone names case-insensitively, and a host typing by hand
    // should not be punished for it. Storage canonicalizes instead.
    ['America/chicago', true],
    ['Central Wedding Time', false],
    ['', false],
    ['Not/A_Zone', false],
    // Fixed-offset identifiers parse in modern engines but are not IANA zones,
    // so they must not be storable as an event time zone.
    ['+05:30', false],
    ['-06:00', false],
  ])('validates the time zone %j as %s', (value, valid) => {
    expect(isIanaTimeZone(value)).toBe(valid);
  });

  it('canonicalizes the stored spelling and refuses invented zones', () => {
    expect(canonicalTimeZone('america/chicago')).toBe('America/Chicago');
    expect(canonicalTimeZone('America/Chicago')).toBe('America/Chicago');
    expect(canonicalTimeZone('Central Wedding Time')).toBeNull();
    expect(canonicalTimeZone('+05:30')).toBeNull();
  });

  it.each<string>([
    '2026-7-30',
    '20260730',
    '2026-07-3',
    '2026-13-01',
    '2026-00-10',
    '2026-07-32',
    '2026-07-00',
    '2026-02-29',
    '',
    'not-a-date',
    '2026-07-30T00:00:00.000Z',
  ])('refuses the calendar date %j', (value) => {
    expect(() => endOfLocalDate(value, 'America/Chicago')).toThrow();
  });

  it('refuses to compute a deadline in an unknown zone', () => {
    expect(() => endOfLocalDate('2026-07-30', 'Central Wedding Time')).toThrow();
    expect(() => localDateForInstant('2026-07-30T00:00:00.000Z', 'Central Wedding Time')).toThrow();
  });

  it('refuses an unparseable instant', () => {
    expect(() => localDateForInstant('not-a-timestamp', 'America/Chicago')).toThrow();
  });
});

describe('event-local start instants', () => {
  it.each<[string, string, string, string]>([
    ['UTC', '2026-07-30', '00:00', '2026-07-30T00:00:00.000Z'],
    ['America/Chicago', '2026-09-19', '17:00', '2026-09-19T22:00:00.000Z'],
    ['Asia/Kolkata', '2026-07-30', '18:30', '2026-07-30T13:00:00.000Z'],
    ['Pacific/Auckland', '2026-07-30', '12:00', '2026-07-30T00:00:00.000Z'],
  ])('places %s %s %s on the absolute timeline', (timeZone, date, time, expected) => {
    expect(instantForLocalDateTime(date, time, timeZone)).toBe(expected);
  });

  it('rejects a local time the zone sprang over', () => {
    // Chicago jumps 02:00 to 03:00 on 2026-03-08, so 02:30 never happens there
    // that day. Silently moving the host's 02:30 to 03:30 would change what the
    // invitation means without telling anyone.
    expect(() => instantForLocalDateTime('2026-03-08', '02:30', 'America/Chicago')).toThrow();
    // The minute either side of the gap does exist, on either side of the jump.
    expect(instantForLocalDateTime('2026-03-08', '01:59', 'America/Chicago'))
      .toBe('2026-03-08T07:59:00.000Z');
    expect(instantForLocalDateTime('2026-03-08', '03:00', 'America/Chicago'))
      .toBe('2026-03-08T08:00:00.000Z');
  });

  it('rejects a midnight the zone sprang over, default or not', () => {
    // Santiago moves its clock at 24:00, so the create form's own 12:00 AM
    // default has no instant on this date and must be refused like any other.
    expect(() => instantForLocalDateTime('2026-09-06', '00:00', 'America/Santiago')).toThrow();
    expect(instantForLocalDateTime('2026-09-06', '01:00', 'America/Santiago'))
      .toBe('2026-09-06T04:00:00.000Z');
  });

  it('resolves a repeated local time to the earlier occurrence', () => {
    // 01:30 happens twice in Chicago on 2026-11-01: once at CDT and again an
    // hour later at CST. The earlier one is chosen, deterministically, so two
    // reads of the same host input never disagree.
    expect(instantForLocalDateTime('2026-11-01', '01:30', 'America/Chicago'))
      .toBe('2026-11-01T06:30:00.000Z');
    expect(instantForLocalDateTime('2026-11-01', '01:30', 'America/Chicago'))
      .not.toBe('2026-11-01T07:30:00.000Z');
  });

  it.each<[string, string, string]>([
    ['UTC', '2026-07-30', '00:00'],
    ['America/Chicago', '2026-09-19', '17:00'],
    ['America/Chicago', '2026-03-08', '03:00'],
    // The repeated hour still reads back as the wall clock the host typed.
    ['America/Chicago', '2026-11-01', '01:30'],
    ['Asia/Kolkata', '2026-07-30', '18:30'],
    ['Pacific/Auckland', '2026-09-27', '23:59'],
  ])('round-trips %s / %s / %s through the event zone', (timeZone, date, time) => {
    const instant = instantForLocalDateTime(date, time, timeZone);
    expect(localDateForInstant(instant, timeZone)).toBe(date);
    expect(localTimeForInstant(instant, timeZone)).toBe(time);
  });

  it('orders a same-day deadline after every start time that day', () => {
    // The rule §5.6 exists for: the deadline is the last local millisecond of
    // its own day, so no start time on the event date can be later than it.
    const deadline = Date.parse(endOfLocalDate('2026-09-19', 'America/Chicago'));
    for (const time of ['00:00', '12:00', '17:00', '23:59']) {
      expect(Date.parse(instantForLocalDateTime('2026-09-19', time, 'America/Chicago')))
        .toBeLessThan(deadline);
    }
  });

  it.each<string>([
    '7:00',
    '07:0',
    '24:00',
    '17:60',
    '17:00:00',
    '5pm',
    '',
  ])('refuses the start time %j', (value) => {
    expect(() => instantForLocalDateTime('2026-07-30', value, 'America/Chicago')).toThrow();
  });

  it('refuses an impossible date and an unknown zone', () => {
    expect(() => instantForLocalDateTime('2026-02-30', '12:00', 'America/Chicago')).toThrow();
    expect(() => instantForLocalDateTime('2026-7-30', '12:00', 'America/Chicago')).toThrow();
    expect(() => instantForLocalDateTime('2026-07-30', '12:00', 'Central Wedding Time')).toThrow();
  });

  it('resolves the same instant whatever zone the machine itself is in', () => {
    // The Worker, the host browser, and the guest browser all run somewhere
    // else, so a start that moved with the process zone would be a different
    // event on every one of them.
    const original = process.env.TZ;
    const resolved = new Set<string>();
    const machineOffsets = new Set<number>();
    try {
      for (const machineZone of ['UTC', 'Asia/Kolkata', 'Pacific/Auckland', 'America/Chicago']) {
        process.env.TZ = machineZone;
        machineOffsets.add(new Date(2026, 8, 19).getTimezoneOffset());
        resolved.add(instantForLocalDateTime('2026-09-19', '17:00', 'America/Chicago'));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    // The process really did move, so one resolved instant is a result rather
    // than an assertion that never had a chance to fail.
    expect(machineOffsets.size).toBe(4);
    expect([...resolved]).toEqual(['2026-09-19T22:00:00.000Z']);
  });
});

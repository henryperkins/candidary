import { describe, expect, it } from 'vitest';

import {
  canonicalTimeZone,
  endOfLocalDate,
  isIanaTimeZone,
  localDateForInstant,
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

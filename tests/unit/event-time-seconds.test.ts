import { describe, expect, it } from 'vitest';

import {
  instantForLocalDateTimeSeconds,
  localDateForInstant,
  localTimeForInstant,
} from '../../shared/event-time';

describe('event-local capture instants with seconds', () => {
  it.each<[string, string, number, number, number, string]>([
    ['UTC', '2026-07-30', 0, 0, 0, '2026-07-30T00:00:00.000Z'],
    ['America/Chicago', '2026-09-19', 17, 0, 42, '2026-09-19T22:00:42.000Z'],
    ['Asia/Kolkata', '2026-07-30', 18, 30, 7, '2026-07-30T13:00:07.000Z'],
    ['Pacific/Auckland', '2026-07-30', 12, 0, 1, '2026-07-30T00:00:01.000Z'],
  ])(
    'places %s %s %s:%s:%s on the absolute timeline without truncating seconds',
    (timeZone, date, hour, minute, second, expected) => {
      expect(instantForLocalDateTimeSeconds(date, hour, minute, second, timeZone)).toBe(expected);
    },
  );

  it('rejects a second-precise local time the zone sprang over', () => {
    expect(() => instantForLocalDateTimeSeconds(
      '2026-03-08', 2, 30, 15, 'America/Chicago',
    )).toThrow();
    expect(instantForLocalDateTimeSeconds('2026-03-08', 1, 59, 59, 'America/Chicago'))
      .toBe('2026-03-08T07:59:59.000Z');
    expect(instantForLocalDateTimeSeconds('2026-03-08', 3, 0, 0, 'America/Chicago'))
      .toBe('2026-03-08T08:00:00.000Z');
  });

  it('resolves a repeated second-precise local time to the earlier occurrence', () => {
    expect(instantForLocalDateTimeSeconds('2026-11-01', 1, 30, 45, 'America/Chicago'))
      .toBe('2026-11-01T06:30:45.000Z');
    expect(instantForLocalDateTimeSeconds('2026-11-01', 1, 30, 45, 'America/Chicago'))
      .not.toBe('2026-11-01T07:30:45.000Z');
  });

  it('round-trips through the event zone without moving the wall clock', () => {
    const instant = instantForLocalDateTimeSeconds(
      '2026-09-19', 17, 0, 42, 'America/Chicago',
    );
    expect(localDateForInstant(instant, 'America/Chicago')).toBe('2026-09-19');
    expect(localTimeForInstant(instant, 'America/Chicago')).toBe('17:00');
  });

  it.each<[string, number, number, number]>([
    ['2026-07-30', 24, 0, 0],
    ['2026-07-30', 0, 60, 0],
    ['2026-07-30', 0, 0, 60],
    ['2026-07-30', -1, 0, 0],
    ['2026-02-30', 12, 0, 0],
    ['2026-07-32', 12, 0, 0],
  ])('refuses date %s with fields %s:%s:%s', (date, hour, minute, second) => {
    expect(() => instantForLocalDateTimeSeconds(
      date, hour, minute, second, 'America/Chicago',
    )).toThrow();
  });

  it('refuses an unknown zone', () => {
    expect(() => instantForLocalDateTimeSeconds(
      '2026-07-30', 12, 0, 0, 'Central Wedding Time',
    )).toThrow();
  });
});

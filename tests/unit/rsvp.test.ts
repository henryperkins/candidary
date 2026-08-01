import { describe, expect, it } from 'vitest';

import type {
  GuestEventPhase,
  GuestPhaseView,
  PhotoIntakeState,
  RsvpAccess,
} from '../../shared/contracts';
import {
  EVENT_START_MIGRATION_SENTINEL,
  MAX_EVENT_RSVP_CAPACITY,
  MAX_HOUSEHOLD_CAPACITY,
  MAX_NAMED_INVITEES_PER_HOUSEHOLD,
  MAX_PLUS_ONES_PER_HOUSEHOLD,
  MAX_RSVP_HOUSEHOLDS,
  RSVP_HOUSEHOLD_KEY_PATTERN,
  deriveRsvpSummary,
  eventStartHasPassed,
  findLookupCollisions,
  isLegacyEventStart,
  normalizeInvitedName,
  parsePersonText,
  resolveGuestEventPhase,
  resolvePhotoIntake,
  type EventLifecycleInput,
} from '../../shared/rsvp';

// Several fixtures below are invisible or near-invisible characters, so every
// case names the exact code point it carries in its label. Read the label, not
// the literal, and keep the two in step when editing.

describe('RSVP domain', () => {
  it('normalizes exact invited names without folding diacritics', () => {
    // Fullwidth M, no-break space, curly apostrophe, en dash.
    const messy = '  ＭARY O’NEIL–SMITH  ';
    expect(normalizeInvitedName(messy)).toBe("mary o'neil-smith");
    expect(normalizeInvitedName('José')).toBe('josé');
    expect(normalizeInvitedName('Jose')).not.toBe(normalizeInvitedName('José'));
  });

  it('composes decomposed diacritics so one person has one lookup key', () => {
    expect(normalizeInvitedName('José')).toBe(normalizeInvitedName('José'));
  });

  it.each<[string, string, string]>([
    ['U+2018 left single quotation mark', 'O‘Neil', "o'neil"],
    ['U+2019 right single quotation mark', 'O’Neil', "o'neil"],
    ['U+02BC modifier letter apostrophe', 'OʼNeil', "o'neil"],
    ['U+2010 hyphen', 'a‐b', 'a-b'],
    ['U+2011 non-breaking hyphen', 'a‑b', 'a-b'],
    ['U+2012 figure dash', 'a‒b', 'a-b'],
    ['U+2013 en dash', 'a–b', 'a-b'],
    ['U+2014 em dash', 'a—b', 'a-b'],
    ['U+2015 horizontal bar', 'a―b', 'a-b'],
    ['U+2212 minus sign', 'a−b', 'a-b'],
  ])('folds %s', (_label, input, expected) => {
    expect(normalizeInvitedName(input)).toBe(expected);
  });

  it.each<[string, string, string]>([
    ['runs of ASCII space', '  Avery   Rivera  ', 'avery rivera'],
    ['U+00A0 no-break space', 'Avery Rivera', 'avery rivera'],
    ['U+3000 ideographic space', 'Avery　Rivera', 'avery rivera'],
    ['a tab', 'Avery\tRivera', 'avery rivera'],
    ['a line break', 'Avery\nRivera', 'avery rivera'],
    ['an empty string', '', ''],
    ['whitespace only', '   ', ''],
  ])('collapses %s', (_label, input, expected) => {
    expect(normalizeInvitedName(input)).toBe(expected);
  });

  it('preserves punctuation other than the approved apostrophe and dash forms', () => {
    expect(normalizeInvitedName('Avery Rivera, Jr.')).toBe('avery rivera, jr.');
    expect(normalizeInvitedName('Anne-Marie St. James')).toBe('anne-marie st. james');
  });

  it('freezes the approved capacity limits', () => {
    expect(MAX_EVENT_RSVP_CAPACITY).toBe(500);
    expect(MAX_RSVP_HOUSEHOLDS).toBe(500);
    expect(MAX_NAMED_INVITEES_PER_HOUSEHOLD).toBe(20);
    expect(MAX_PLUS_ONES_PER_HOUSEHOLD).toBe(10);
    expect(MAX_HOUSEHOLD_CAPACITY).toBe(30);
  });

  it.each<[string, boolean]>([
    ['perkins', true],
    ['0', true],
    ['a_b-c', true],
    ['a'.repeat(64), true],
    ['a'.repeat(65), false],
    ['', false],
    ['_perkins', false],
    ['-perkins', false],
    ['Perkins', false],
    ['perkins household', false],
    ['perkins.household', false],
  ])('accepts only lowercase stable household keys (%s)', (value, valid) => {
    expect(RSVP_HOUSEHOLD_KEY_PATTERN.test(value)).toBe(valid);
  });
});

// One event, read at many instants, so every case below differs only in when it
// was asked. The RSVP deadline is the last local millisecond of 2026-09-18 in
// America/Chicago and the start is 5:00 PM local on the 19th, which is the
// strict ordering the Worker validates.
const DEADLINE_AT = '2026-09-19T04:59:59.999Z';
// The first millisecond RSVP reads as closed. The deadline instant itself is
// still open, so this is the boundary a guest view is scheduled against.
const RSVP_CLOSES_AT = '2026-09-19T05:00:00.000Z';
const START_AT = '2026-09-19T22:00:00.000Z';
const EARLY_OPEN_AT = '2026-09-18T09:00:00.000Z';

const BEFORE_EARLY_OPEN = '2026-09-18T08:00:00.000Z';
const BEFORE_DEADLINE = '2026-09-18T12:00:00.000Z';
const AFTER_DEADLINE = '2026-09-19T06:00:00.000Z';
const AFTER_START = '2026-09-19T23:00:00.000Z';

const scheduled: EventLifecycleInput = {
  uploadsEnabled: true,
  rsvpEnabled: true,
  rsvpDeadlineAt: DEADLINE_AT,
  eventStartAt: START_AT,
  photosOpenFrom: null,
};

const earlyOpened: EventLifecycleInput = { ...scheduled, photosOpenFrom: EARLY_OPEN_AT };

// Written as a subtraction rather than a literal so a reader checks the two
// instants, which are the contract, instead of arithmetic that is not.
function msBetween(from: string, to: string): number {
  return Date.parse(to) - Date.parse(from);
}

function phaseAt(override: Partial<EventLifecycleInput>, now: string): GuestPhaseView {
  return resolveGuestEventPhase({ ...scheduled, ...override }, new Date(now));
}

describe('guest event phase', () => {
  it.each<[string, Partial<EventLifecycleInput>, string, GuestPhaseView]>([
    [
      'an open RSVP before the start is the whole page',
      {}, BEFORE_DEADLINE,
      {
        phase: 'rsvp-primary', rsvpState: 'open', rsvpAccess: 'editable',
        lifecycleRecheckAfterMs: msBetween(BEFORE_DEADLINE, RSVP_CLOSES_AT),
      },
    ],
    [
      'a closed RSVP before the start is its own surface',
      {}, AFTER_DEADLINE,
      {
        phase: 'before-start', rsvpState: 'closed', rsvpAccess: 'read-only',
        lifecycleRecheckAfterMs: msBetween(AFTER_DEADLINE, START_AT),
      },
    ],
    [
      'a roster the host has not switched on yet is that surface too',
      { rsvpEnabled: false }, BEFORE_DEADLINE,
      {
        phase: 'before-start', rsvpState: 'paused', rsvpAccess: 'read-only',
        lifecycleRecheckAfterMs: msBetween(BEFORE_DEADLINE, RSVP_CLOSES_AT),
      },
    ],
    [
      'an event that never adopted RSVP advertises no household lookup',
      { rsvpEnabled: false, rsvpDeadlineAt: null }, BEFORE_DEADLINE,
      {
        phase: 'before-start', rsvpState: 'disabled', rsvpAccess: 'unavailable',
        lifecycleRecheckAfterMs: msBetween(BEFORE_DEADLINE, START_AT),
      },
    ],
    [
      'an unreadable deadline is disabled rather than open',
      { rsvpDeadlineAt: 'not-a-timestamp' }, BEFORE_DEADLINE,
      {
        phase: 'before-start', rsvpState: 'disabled', rsvpAccess: 'unavailable',
        lifecycleRecheckAfterMs: msBetween(BEFORE_DEADLINE, START_AT),
      },
    ],
    [
      'the start opens photo delivery with no host action',
      {}, START_AT,
      {
        phase: 'photos-primary', rsvpState: 'closed', rsvpAccess: 'unavailable',
        lifecycleRecheckAfterMs: null,
      },
    ],
    [
      'a host pause after the start is the waiting surface',
      { uploadsEnabled: false }, AFTER_START,
      {
        phase: 'waiting', rsvpState: 'closed', rsvpAccess: 'unavailable',
        lifecycleRecheckAfterMs: null,
      },
    ],
    [
      'an early opening makes photos primary while RSVP is still open',
      { photosOpenFrom: EARLY_OPEN_AT }, BEFORE_DEADLINE,
      {
        phase: 'photos-primary', rsvpState: 'open', rsvpAccess: 'editable',
        lifecycleRecheckAfterMs: msBetween(BEFORE_DEADLINE, RSVP_CLOSES_AT),
      },
    ],
    [
      'a disabled printed entry withdraws every household affordance',
      { entryDisabled: true, uploadsEnabled: false, rsvpEnabled: false }, BEFORE_DEADLINE,
      {
        phase: 'before-start', rsvpState: 'paused', rsvpAccess: 'unavailable',
        lifecycleRecheckAfterMs: msBetween(BEFORE_DEADLINE, RSVP_CLOSES_AT),
      },
    ],
  ])('%s', (_label, override, now, expected) => {
    expect(phaseAt(override, now)).toEqual(expected);
  });

  it('never reports an open RSVP state without a deadline', () => {
    for (const rsvpEnabled of [true, false]) {
      expect(phaseAt({ rsvpEnabled, rsvpDeadlineAt: null }, BEFORE_DEADLINE).rsvpState)
        .toBe('disabled');
    }
  });
});

describe('guest phase boundaries', () => {
  it('keeps the deadline millisecond open and closes on the next one', () => {
    expect(phaseAt({}, DEADLINE_AT)).toEqual({
      phase: 'rsvp-primary', rsvpState: 'open', rsvpAccess: 'editable',
      // One millisecond, because the boundary worth waking for is the first
      // closed instant and not the deadline that is still open.
      lifecycleRecheckAfterMs: 1,
    });
    expect(phaseAt({}, RSVP_CLOSES_AT)).toEqual({
      phase: 'before-start', rsvpState: 'closed', rsvpAccess: 'read-only',
      lifecycleRecheckAfterMs: msBetween(RSVP_CLOSES_AT, START_AT),
    });
  });

  it('opens photo delivery on the start instant itself, not the one after', () => {
    const oneBefore = new Date(Date.parse(START_AT) - 1).toISOString();
    expect(phaseAt({}, oneBefore)).toEqual({
      phase: 'before-start', rsvpState: 'closed', rsvpAccess: 'read-only',
      lifecycleRecheckAfterMs: 1,
    });
    expect(phaseAt({}, START_AT)).toEqual({
      phase: 'photos-primary', rsvpState: 'closed', rsvpAccess: 'unavailable',
      lifecycleRecheckAfterMs: null,
    });
  });

  it('opens photo delivery on the early instant itself', () => {
    const oneBefore = new Date(Date.parse(EARLY_OPEN_AT) - 1).toISOString();
    expect(phaseAt({ photosOpenFrom: EARLY_OPEN_AT }, oneBefore)).toMatchObject({
      phase: 'rsvp-primary',
      lifecycleRecheckAfterMs: 1,
    });
    expect(phaseAt({ photosOpenFrom: EARLY_OPEN_AT }, EARLY_OPEN_AT)).toMatchObject({
      phase: 'photos-primary',
      rsvpAccess: 'editable',
    });
  });
});

describe('guest RSVP access', () => {
  it.each<[string, Partial<EventLifecycleInput>, string]>([
    ['the deadline has passed', {}, START_AT],
    ['RSVP is paused', { rsvpEnabled: false }, START_AT],
    ['RSVP was never configured', { rsvpDeadlineAt: null }, START_AT],
    ['photo delivery is paused', { uploadsEnabled: false }, AFTER_START],
    ['photo delivery opened early', { photosOpenFrom: EARLY_OPEN_AT }, AFTER_START],
    // Validation refuses a deadline that outlives the start, so this state
    // cannot be reached through the API. The rule is unconditional anyway: at
    // the start RSVP has left the guest experience, and that is not a deadline
    // comparison.
    ['a deadline outlives the start', { rsvpDeadlineAt: '2026-09-20T04:59:59.999Z' }, START_AT],
  ])('is unavailable at or after the start when %s', (_label, override, now) => {
    expect(phaseAt(override, now).rsvpAccess).toBe('unavailable');
  });

  it.each<[string, Partial<EventLifecycleInput>, string, RsvpAccess]>([
    ['a disabled printed entry over an open RSVP', { entryDisabled: true }, BEFORE_DEADLINE, 'unavailable'],
    ['a disabled printed entry over a paused one', { entryDisabled: true, rsvpEnabled: false }, BEFORE_DEADLINE, 'unavailable'],
    ['no deadline at all', { rsvpDeadlineAt: null }, BEFORE_DEADLINE, 'unavailable'],
    ['an unreadable deadline', { rsvpDeadlineAt: 'not-a-timestamp' }, BEFORE_DEADLINE, 'unavailable'],
    ['an open RSVP', {}, BEFORE_DEADLINE, 'editable'],
    ['a paused RSVP', { rsvpEnabled: false }, BEFORE_DEADLINE, 'read-only'],
    ['a closed RSVP', {}, AFTER_DEADLINE, 'read-only'],
    ['a closed RSVP the host never switched on', { rsvpEnabled: false }, AFTER_DEADLINE, 'read-only'],
  ])('before the start, %s is %s', (_label, override, now, expected) => {
    expect(phaseAt(override, now).rsvpAccess).toBe(expected);
  });

  it.each<[string, Partial<EventLifecycleInput>, string, RsvpAccess]>([
    ['editable', {}, BEFORE_DEADLINE, 'editable'],
    ['read-only', {}, AFTER_DEADLINE, 'read-only'],
    ['unavailable', { entryDisabled: true }, BEFORE_DEADLINE, 'unavailable'],
  ])('an early-open page can hold RSVP %s before the start', (_label, override, now, expected) => {
    const view = resolveGuestEventPhase({ ...earlyOpened, ...override }, new Date(now));
    expect(view.phase).toBe('photos-primary');
    expect(view.rsvpAccess).toBe(expected);
  });
});

describe('guest lifecycle recheck delay', () => {
  it('tracks the disclosure across an early-open period the phase never leaves', () => {
    // The phase does not move at the deadline or at the start here, but the
    // household disclosure goes editable, then read-only, then away, so every
    // one of those instants is still a boundary worth waking for.
    const walk = [BEFORE_EARLY_OPEN, BEFORE_DEADLINE, AFTER_DEADLINE, AFTER_START]
      .map((now) => {
        const { phase, rsvpAccess, lifecycleRecheckAfterMs } = resolveGuestEventPhase(
          earlyOpened,
          new Date(now),
        );
        return { phase, rsvpAccess, lifecycleRecheckAfterMs };
      });

    expect(walk).toEqual([
      {
        phase: 'rsvp-primary', rsvpAccess: 'editable',
        lifecycleRecheckAfterMs: msBetween(BEFORE_EARLY_OPEN, EARLY_OPEN_AT),
      },
      {
        phase: 'photos-primary', rsvpAccess: 'editable',
        lifecycleRecheckAfterMs: msBetween(BEFORE_DEADLINE, RSVP_CLOSES_AT),
      },
      {
        phase: 'photos-primary', rsvpAccess: 'read-only',
        lifecycleRecheckAfterMs: msBetween(AFTER_DEADLINE, START_AT),
      },
      { phase: 'photos-primary', rsvpAccess: 'unavailable', lifecycleRecheckAfterMs: null },
    ]);
  });

  it('never schedules a boundary that has already gone', () => {
    // A deadline behind the resolving instant is not a boundary, so the start
    // is what remains; past the start nothing is.
    expect(phaseAt({}, AFTER_DEADLINE).lifecycleRecheckAfterMs)
      .toBe(msBetween(AFTER_DEADLINE, START_AT));
    expect(phaseAt({}, AFTER_START).lifecycleRecheckAfterMs).toBeNull();
    expect(phaseAt({ uploadsEnabled: false }, AFTER_START).lifecycleRecheckAfterMs).toBeNull();
  });

  it('measures from the instant it was handed, never from the machine clock', () => {
    const early = phaseAt({}, BEFORE_DEADLINE).lifecycleRecheckAfterMs;
    const late = phaseAt({}, '2026-09-18T13:00:00.000Z').lifecycleRecheckAfterMs;
    expect(early).not.toBeNull();
    expect(late).toBe((early ?? 0) - 60 * 60 * 1000);
  });
});

describe('migration-sentinel events', () => {
  const legacy: EventLifecycleInput = {
    ...scheduled,
    eventStartAt: EVENT_START_MIGRATION_SENTINEL,
  };

  it('recognizes the sentinel and every start it cannot read', () => {
    expect(isLegacyEventStart(EVENT_START_MIGRATION_SENTINEL)).toBe(true);
    expect(isLegacyEventStart('not-a-timestamp')).toBe(true);
    expect(isLegacyEventStart(START_AT)).toBe(false);
  });

  it('never lets a sentinel start pass, however late it is read', () => {
    expect(eventStartHasPassed(EVENT_START_MIGRATION_SENTINEL, new Date(AFTER_START))).toBe(false);
    expect(eventStartHasPassed('not-a-timestamp', new Date(AFTER_START))).toBe(false);
    expect(eventStartHasPassed(START_AT, new Date(Date.parse(START_AT) - 1))).toBe(false);
    expect(eventStartHasPassed(START_AT, new Date(START_AT))).toBe(true);
  });

  it('restores uploadsEnabled as the unconditional override', () => {
    expect(phaseAt({ eventStartAt: EVENT_START_MIGRATION_SENTINEL }, BEFORE_DEADLINE).phase)
      .toBe('photos-primary');
    // Uploads off with RSVP open is the case the epoch would otherwise decide:
    // its instant is long past, so the new rules would call this row started and
    // begin refusing RSVPs at a start it does not really have.
    expect(resolveGuestEventPhase({ ...legacy, uploadsEnabled: false }, new Date(AFTER_START)))
      .toEqual({
        phase: 'waiting', rsvpState: 'closed', rsvpAccess: 'read-only',
        lifecycleRecheckAfterMs: null,
      });
    expect(resolveGuestEventPhase({ ...legacy, uploadsEnabled: false }, new Date(BEFORE_DEADLINE)))
      .toEqual({
        phase: 'rsvp-primary', rsvpState: 'open', rsvpAccess: 'editable',
        lifecycleRecheckAfterMs: msBetween(BEFORE_DEADLINE, RSVP_CLOSES_AT),
      });
  });

  it('never reaches before-start, which is a post-0010 state', () => {
    const phases = new Set<GuestEventPhase>();
    for (const uploadsEnabled of [true, false]) {
      for (const rsvpEnabled of [true, false]) {
        for (const now of [BEFORE_DEADLINE, AFTER_DEADLINE, START_AT, AFTER_START]) {
          phases.add(resolveGuestEventPhase(
            { ...legacy, uploadsEnabled, rsvpEnabled },
            new Date(now),
          ).phase);
        }
      }
    }
    expect([...phases].sort()).toEqual(['photos-primary', 'rsvp-primary', 'waiting']);
  });
});

describe('host photo intake state', () => {
  it.each<[string, Partial<EventLifecycleInput>, string, PhotoIntakeState, boolean]>([
    ['withheld capability outranks a schedule that has not opened', { uploadsEnabled: false }, BEFORE_DEADLINE, 'paused', false],
    ['withheld capability outranks an early opening', { uploadsEnabled: false, photosOpenFrom: EARLY_OPEN_AT }, BEFORE_DEADLINE, 'paused', false],
    ['withheld capability outranks the start itself', { uploadsEnabled: false }, AFTER_START, 'paused', false],
    ['permitted and waiting on the clock', {}, BEFORE_DEADLINE, 'scheduled', false],
    ['permitted past a manual opening but before the start', { photosOpenFrom: EARLY_OPEN_AT }, BEFORE_DEADLINE, 'open-early', true],
    ['permitted at the start', {}, START_AT, 'open', true],
    ['permitted after the start', {}, AFTER_START, 'open', true],
  ])('%s reports %s', (_label, override, now, photoIntakeState, photosOpen) => {
    expect(resolvePhotoIntake({ ...scheduled, ...override }, new Date(now)))
      .toMatchObject({ photoIntakeState, photosOpen });
  });

  it('opens on the scheduled instant itself', () => {
    const beforeStart = new Date(Date.parse(START_AT) - 1);
    expect(resolvePhotoIntake(scheduled, beforeStart).photoIntakeState).toBe('scheduled');
    expect(resolvePhotoIntake(scheduled, new Date(START_AT)).photoIntakeState).toBe('open');

    const beforeEarly = new Date(Date.parse(EARLY_OPEN_AT) - 1);
    expect(resolvePhotoIntake(earlyOpened, beforeEarly).photoIntakeState).toBe('scheduled');
    expect(resolvePhotoIntake(earlyOpened, new Date(EARLY_OPEN_AT)).photoIntakeState)
      .toBe('open-early');
  });

  it('schedules its own refetch from the opening and the start, never the deadline', () => {
    expect(resolvePhotoIntake(scheduled, new Date(BEFORE_DEADLINE)).photoIntakeRecheckAfterMs)
      .toBe(msBetween(BEFORE_DEADLINE, START_AT));
    expect(resolvePhotoIntake(earlyOpened, new Date(BEFORE_EARLY_OPEN)).photoIntakeRecheckAfterMs)
      .toBe(msBetween(BEFORE_EARLY_OPEN, EARLY_OPEN_AT));
    expect(resolvePhotoIntake(earlyOpened, new Date(AFTER_DEADLINE)).photoIntakeRecheckAfterMs)
      .toBe(msBetween(AFTER_DEADLINE, START_AT));
    expect(resolvePhotoIntake(scheduled, new Date(AFTER_START)).photoIntakeRecheckAfterMs)
      .toBeNull();
  });

  it('keeps a paused event on the same boundary, so its page still refreshes', () => {
    expect(resolvePhotoIntake(
      { ...scheduled, uploadsEnabled: false },
      new Date(BEFORE_DEADLINE),
    ).photoIntakeRecheckAfterMs).toBe(msBetween(BEFORE_DEADLINE, START_AT));
  });
});

describe('person text validation', () => {
  it('keeps display casing, diacritics, and host punctuation', () => {
    // U+2019 survives here on purpose. Display text is what the host wrote;
    // only the lookup key folds it to an ASCII apostrophe.
    const typed = '  José   O’Neil  ';
    expect(parsePersonText(typed)).toEqual({ ok: true, value: 'José O’Neil' });
    expect(normalizeInvitedName(typed)).toBe("josé o'neil");
  });

  it.each<[string, string, string]>([
    ['an empty string', '', 'empty'],
    ['ASCII whitespace only', '    ', 'empty'],
    ['U+00A0 no-break space only', '  ', 'empty'],
    ['eighty-one characters', 'a'.repeat(81), 'too_long'],
    ['a line feed', 'Avery\nRivera', 'control_character'],
    ['a CRLF', 'Avery\r\nRivera', 'control_character'],
    ['a tab', 'Avery\tRivera', 'control_character'],
    ['U+200B zero width space', 'Avery​Rivera', 'control_character'],
    ['U+200D zero width joiner', 'Avery‍Rivera', 'control_character'],
    ['U+202E right-to-left override', 'Avery‮Rivera', 'control_character'],
    ['U+FEFF byte order mark', '﻿Avery', 'control_character'],
    ['U+00AD soft hyphen', 'Avery­Rivera', 'control_character'],
  ])('rejects %s', (_label, input, issue) => {
    expect(parsePersonText(input)).toEqual({ ok: false, issue });
  });

  it('accepts exactly eighty characters', () => {
    const eighty = 'a'.repeat(80);
    expect(parsePersonText(eighty)).toEqual({ ok: true, value: eighty });
  });

  it('measures length after whitespace collapse, not before', () => {
    expect(parsePersonText(`${'a'.repeat(80)}     `)).toEqual({ ok: true, value: 'a'.repeat(80) });
  });
});

describe('lookup collision resolvability', () => {
  it('reports nothing when every named person is unique', () => {
    expect(findLookupCollisions([
      { householdId: 'h1', nameKeys: ['avery rivera'] },
      { householdId: 'h2', nameKeys: ['jordan perkins', 'henry perkins'] },
    ])).toEqual([]);
  });

  it('blocks identical single-person households', () => {
    expect(findLookupCollisions([
      { householdId: 'h1', nameKeys: ['alex lee'] },
      { householdId: 'h2', nameKeys: ['alex lee'] },
    ])).toEqual([
      { householdId: 'h1', nameKey: 'alex lee', code: 'household_lookup_unresolvable' },
      { householdId: 'h2', nameKey: 'alex lee', code: 'household_lookup_unresolvable' },
    ]);
  });

  it('allows a shared name when a second household member disambiguates it', () => {
    expect(findLookupCollisions([
      { householdId: 'h1', nameKeys: ['alex lee', 'sam lee'] },
      { householdId: 'h2', nameKeys: ['alex lee', 'pat lee'] },
    ])).toEqual([]);
  });

  it('blocks two households whose complete name sets are identical', () => {
    expect(findLookupCollisions([
      { householdId: 'h1', nameKeys: ['alex lee', 'sam lee'] },
      { householdId: 'h2', nameKeys: ['alex lee', 'sam lee'] },
    ])).toEqual([
      { householdId: 'h1', nameKey: 'alex lee', code: 'household_lookup_unresolvable' },
      { householdId: 'h1', nameKey: 'sam lee', code: 'household_lookup_unresolvable' },
      { householdId: 'h2', nameKey: 'alex lee', code: 'household_lookup_unresolvable' },
      { householdId: 'h2', nameKey: 'sam lee', code: 'household_lookup_unresolvable' },
    ]);
  });

  it('blocks a household that repeats one normalized name', () => {
    expect(findLookupCollisions([
      { householdId: 'h1', nameKeys: ['alex lee', 'alex lee'] },
    ])).toEqual([
      { householdId: 'h1', nameKey: 'alex lee', code: 'household_duplicate_name' },
    ]);
  });

  it('does not let a repeated in-household name masquerade as a disambiguator', () => {
    expect(findLookupCollisions([
      { householdId: 'h1', nameKeys: ['alex lee', 'alex lee'] },
      { householdId: 'h2', nameKeys: ['alex lee'] },
    ])).toEqual([
      { householdId: 'h1', nameKey: 'alex lee', code: 'household_duplicate_name' },
      { householdId: 'h1', nameKey: 'alex lee', code: 'household_lookup_unresolvable' },
      { householdId: 'h2', nameKey: 'alex lee', code: 'household_lookup_unresolvable' },
    ]);
  });

  it('accepts a disambiguator that is itself shared, as long as the pair narrows to one', () => {
    // "sam lee" is in h1 and h3, so it is not unique. It still resolves h1,
    // because {h1,h2} intersected with {h1,h3} is exactly {h1}. A rule that
    // demanded a globally unique second name would wrongly block this roster.
    expect(findLookupCollisions([
      { householdId: 'h1', nameKeys: ['alex lee', 'sam lee'] },
      { householdId: 'h2', nameKeys: ['alex lee', 'pat lee'] },
      { householdId: 'h3', nameKeys: ['sam lee', 'jo kim'] },
    ])).toEqual([]);
  });

  it('needs the disambiguator to intersect down to exactly one household', () => {
    // "sam lee" sits in both households, so it cannot separate them even though
    // it is not the name that was searched for. Only h2 has a unique second name.
    expect(findLookupCollisions([
      { householdId: 'h1', nameKeys: ['alex lee', 'sam lee'] },
      { householdId: 'h2', nameKeys: ['alex lee', 'sam lee', 'pat lee'] },
    ])).toEqual([
      { householdId: 'h1', nameKey: 'alex lee', code: 'household_lookup_unresolvable' },
      { householdId: 'h1', nameKey: 'sam lee', code: 'household_lookup_unresolvable' },
    ]);
  });
});

describe('derived RSVP totals', () => {
  const household = (
    archived: boolean,
    invitees: Array<['named' | 'plus_one', 'pending' | 'attending' | 'declined']>,
  ) => ({
    archived,
    invitees: invitees.map(([kind, attendance]) => ({ kind, attendance })),
  });

  it('counts only active households and derives capacity from rows', () => {
    expect(deriveRsvpSummary([
      household(false, [['named', 'attending'], ['named', 'declined'], ['plus_one', 'attending']]),
      household(false, [['named', 'pending'], ['plus_one', 'pending']]),
      household(true, [['named', 'attending'], ['plus_one', 'attending']]),
    ])).toEqual({
      invitedCapacity: 5,
      namedInvitees: 3,
      plusOneCapacity: 2,
      attending: 2,
      declined: 1,
      awaitingResponse: 2,
      householdsResponded: 1,
      householdsAwaitingResponse: 1,
    });
  });

  it('treats a household with any pending row as awaiting', () => {
    const summary = deriveRsvpSummary([
      household(false, [['named', 'attending'], ['plus_one', 'pending']]),
    ]);
    expect(summary.householdsResponded).toBe(0);
    expect(summary.householdsAwaitingResponse).toBe(1);
  });

  it('treats an all-declined household as responded', () => {
    const summary = deriveRsvpSummary([
      household(false, [['named', 'declined'], ['plus_one', 'declined']]),
    ]);
    expect(summary.householdsResponded).toBe(1);
    expect(summary.attending).toBe(0);
    expect(summary.invitedCapacity).toBe(2);
  });

  it('returns zeroed totals for an empty roster', () => {
    expect(deriveRsvpSummary([])).toEqual({
      invitedCapacity: 0,
      namedInvitees: 0,
      plusOneCapacity: 0,
      attending: 0,
      declined: 0,
      awaitingResponse: 0,
      householdsResponded: 0,
      householdsAwaitingResponse: 0,
    });
  });
});

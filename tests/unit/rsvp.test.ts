import { describe, expect, it } from 'vitest';

import type { GuestPhaseView, RsvpState } from '../../shared/contracts';
import {
  MAX_EVENT_RSVP_CAPACITY,
  MAX_HOUSEHOLD_CAPACITY,
  MAX_NAMED_INVITEES_PER_HOUSEHOLD,
  MAX_PLUS_ONES_PER_HOUSEHOLD,
  MAX_RSVP_HOUSEHOLDS,
  RSVP_HOUSEHOLD_KEY_PATTERN,
  deriveRsvpSummary,
  findLookupCollisions,
  normalizeInvitedName,
  parsePersonText,
  resolveGuestEventPhase,
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

  it('uses server time to select phase and close RSVP', () => {
    const input = {
      uploadsEnabled: false,
      rsvpEnabled: true,
      rsvpDeadlineAt: '2026-07-31T04:59:59.999Z',
    };
    expect(resolveGuestEventPhase(input, new Date('2026-07-31T04:59:59.999Z')))
      .toEqual({ phase: 'rsvp-primary', rsvpState: 'open' });
    expect(resolveGuestEventPhase(input, new Date('2026-07-31T05:00:00.000Z')))
      .toEqual({ phase: 'waiting', rsvpState: 'closed' });
    expect(resolveGuestEventPhase(
      { ...input, uploadsEnabled: true },
      new Date('2026-07-30T12:00:00.000Z'),
    )).toEqual({ phase: 'photos-primary', rsvpState: 'open' });
  });

  it.each<[
    string,
    { uploadsEnabled: boolean; rsvpEnabled: boolean; rsvpDeadlineAt: string | null },
    GuestPhaseView,
  ]>([
    [
      'paused RSVP before the deadline waits',
      { uploadsEnabled: false, rsvpEnabled: false, rsvpDeadlineAt: '2026-07-31T04:59:59.999Z' },
      { phase: 'waiting', rsvpState: 'paused' },
    ],
    [
      'no deadline is disabled, never open',
      { uploadsEnabled: false, rsvpEnabled: false, rsvpDeadlineAt: null },
      { phase: 'waiting', rsvpState: 'disabled' },
    ],
    [
      'photos-only events skip RSVP entirely',
      { uploadsEnabled: true, rsvpEnabled: false, rsvpDeadlineAt: null },
      { phase: 'photos-primary', rsvpState: 'disabled' },
    ],
    [
      'event day keeps photos primary after RSVP closes',
      { uploadsEnabled: true, rsvpEnabled: true, rsvpDeadlineAt: '2026-07-01T04:59:59.999Z' },
      { phase: 'photos-primary', rsvpState: 'closed' },
    ],
    [
      'paused RSVP still yields to open photo intake',
      { uploadsEnabled: true, rsvpEnabled: false, rsvpDeadlineAt: '2026-07-31T04:59:59.999Z' },
      { phase: 'photos-primary', rsvpState: 'paused' },
    ],
    [
      'an unparseable deadline is disabled rather than open',
      { uploadsEnabled: false, rsvpEnabled: true, rsvpDeadlineAt: 'not-a-timestamp' },
      { phase: 'waiting', rsvpState: 'disabled' },
    ],
  ])('%s', (_label, input, expected) => {
    expect(resolveGuestEventPhase(input, new Date('2026-07-30T12:00:00.000Z'))).toEqual(expected);
  });

  it('never reports an open RSVP state without a deadline', () => {
    const states: RsvpState[] = [true, false].map((rsvpEnabled) => resolveGuestEventPhase(
      { uploadsEnabled: false, rsvpEnabled, rsvpDeadlineAt: null },
      new Date('2026-07-30T12:00:00.000Z'),
    ).rsvpState);
    expect(states).toEqual(['disabled', 'disabled']);
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

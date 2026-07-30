import { describe, expect, it } from 'vitest';

import { MAX_RSVP_CSV_BYTES } from '../../shared/constants';
import { csvCell, parseRsvpCsv } from '../../shared/csv';

const HEADER = 'household_key,household_label,invitee_name,plus_one_slots';
// Built rather than typed: a literal U+FEFF inside a template is both invisible
// and an ESLint irregular-whitespace error.
const BOM = String.fromCharCode(0xfeff);

const file = (...rows: string[]) => [HEADER, ...rows].join('\n');

const codes = (csv: string) => parseRsvpCsv(csv).issues.map((issue) => issue.code);

describe('RSVP CSV parsing', () => {
  it('reads the approved sample into households, invitees, and totals', () => {
    const parsed = parseRsvpCsv(file(
      'perkins,Perkins household,Henry Perkins,1',
      'perkins,Perkins household,Jordan Perkins,1',
      'rivera,Rivera household,Avery Rivera,0',
    ));

    expect(parsed.issues).toEqual([]);
    expect(parsed.households).toEqual([
      {
        householdKey: 'perkins',
        label: 'Perkins household',
        plusOneSlots: 1,
        invitees: [
          { displayName: 'Henry Perkins', normalizedName: 'henry perkins' },
          { displayName: 'Jordan Perkins', normalizedName: 'jordan perkins' },
        ],
      },
      {
        householdKey: 'rivera',
        label: 'Rivera household',
        plusOneSlots: 0,
        invitees: [
          { displayName: 'Avery Rivera', normalizedName: 'avery rivera' },
        ],
      },
    ]);
    expect(parsed.totals).toEqual({
      households: 2,
      namedInvitees: 3,
      plusOneCapacity: 1,
      invitedCapacity: 4,
    });
  });

  it('accepts an optional UTF-8 BOM, CRLF endings, and a trailing newline', () => {
    const parsed = parseRsvpCsv(
      `${BOM}${HEADER}\r\nrivera,Rivera household,Avery Rivera,0\r\n`,
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.households).toHaveLength(1);
    expect(parsed.households[0]!.householdKey).toBe('rivera');
  });

  it('reads quoted commas and doubled quotes without splitting on commas', () => {
    const parsed = parseRsvpCsv(file(
      '"rivera","Rivera, Sanchez & co.","Avery ""AJ"" Rivera",0',
    ));
    expect(parsed.issues).toEqual([]);
    expect(parsed.households[0]).toMatchObject({
      label: 'Rivera, Sanchez & co.',
      invitees: [{ displayName: 'Avery "AJ" Rivera' }],
    });
  });

  it('parses a quoted newline structurally but refuses it as a product field', () => {
    expect(codes(file('rivera,"Rivera\nhousehold",Avery Rivera,0')))
      .toEqual(['household_label_invalid']);
  });

  it('trims surrounding whitespace before validating and storing', () => {
    const parsed = parseRsvpCsv(file('  rivera  ,  Rivera household  ,  Avery Rivera  ,  0  '));
    expect(parsed.issues).toEqual([]);
    expect(parsed.households[0]).toMatchObject({
      householdKey: 'rivera',
      label: 'Rivera household',
      plusOneSlots: 0,
    });
  });

  it.each<[string, string]>([
    ['a different column order', 'household_label,household_key,invitee_name,plus_one_slots'],
    ['a missing column', 'household_key,household_label,invitee_name'],
    ['an extra column', `${HEADER},meal`],
    ['a renamed column', 'household_key,household_label,guest_name,plus_one_slots'],
    ['title case', 'Household_Key,household_label,invitee_name,plus_one_slots'],
  ])('rejects %s', (_label, header) => {
    const parsed = parseRsvpCsv(`${header}\nrivera,Rivera household,Avery Rivera,0`);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ row: 1, field: 'file', code: 'header_invalid', blocking: true }),
    ]);
    expect(parsed.households).toEqual([]);
  });

  it('rejects a header-only file', () => {
    expect(parseRsvpCsv(HEADER).issues).toEqual([
      expect.objectContaining({ row: 0, field: 'file', code: 'file_empty' }),
    ]);
  });

  it.each<[string, string]>([
    ['too few fields', 'rivera,Rivera household,Avery Rivera'],
    ['too many fields', 'rivera,Rivera household,Avery Rivera,0,extra'],
    ['an unterminated quote', 'rivera,"Rivera household,Avery Rivera,0'],
    ['a stray quote inside an unquoted field', 'rivera,Rivera "household,Avery Rivera,0'],
  ])('rejects %s as a malformed row', (_label, row) => {
    const parsed = parseRsvpCsv(file(row));
    expect(parsed.issues).toEqual([
      expect.objectContaining({ code: 'row_malformed', blocking: true }),
    ]);
    expect(parsed.households).toEqual([]);
  });

  it('refuses a file larger than the published byte limit before parsing it', () => {
    const oversized = file(`perkins,${'a'.repeat(MAX_RSVP_CSV_BYTES)},Henry Perkins,0`);
    expect(parseRsvpCsv(oversized).issues).toEqual([
      expect.objectContaining({ row: 0, field: 'file', code: 'file_too_large' }),
    ]);
  });

  it('measures the byte limit in UTF-8 bytes, not code units', () => {
    // Four bytes per code point, so half the limit in characters is over it.
    const wide = '🎉'.repeat(Math.ceil(MAX_RSVP_CSV_BYTES / 3));
    expect(codes(file(`perkins,${wide},Henry Perkins,0`))).toEqual(['file_too_large']);
  });

  it.each<[string, string, string]>([
    ['an uppercase key', 'Perkins,Perkins household,Henry Perkins,0', 'household_key_invalid'],
    ['a key with a space', 'perkins family,Perkins,Henry Perkins,0', 'household_key_invalid'],
    ['a key starting with an underscore', '_perkins,Perkins,Henry Perkins,0', 'household_key_invalid'],
    ['an empty key', ',Perkins,Henry Perkins,0', 'household_key_invalid'],
    ['a 65-character key', `${'a'.repeat(65)},Perkins,Henry Perkins,0`, 'household_key_invalid'],
    ['an empty label', 'perkins,,Henry Perkins,0', 'household_label_invalid'],
    ['an 81-character label', `perkins,${'a'.repeat(81)},Henry Perkins,0`, 'household_label_invalid'],
    ['an empty name', 'perkins,Perkins,,0', 'invitee_name_invalid'],
    ['an 81-character name', `perkins,Perkins,${'a'.repeat(81)},0`, 'invitee_name_invalid'],
    ['a non-numeric slot count', 'perkins,Perkins,Henry Perkins,one', 'plus_one_slots_invalid'],
    ['a negative slot count', 'perkins,Perkins,Henry Perkins,-1', 'plus_one_slots_invalid'],
    ['a fractional slot count', 'perkins,Perkins,Henry Perkins,1.5', 'plus_one_slots_invalid'],
    ['an empty slot count', 'perkins,Perkins,Henry Perkins,', 'plus_one_slots_invalid'],
    ['eleven plus-one slots', 'perkins,Perkins,Henry Perkins,11', 'plus_one_slots_invalid'],
  ])('rejects %s', (_label, row, code) => {
    expect(codes(file(row))).toEqual([code]);
  });

  it('reports every offending row rather than stopping at the first', () => {
    const parsed = parseRsvpCsv(file(
      'Perkins,Perkins household,Henry Perkins,0',
      'rivera,Rivera household,Avery Rivera,0',
      'lee,Lee household,,0',
    ));
    expect(parsed.issues.map((issue) => [issue.row, issue.code])).toEqual([
      [2, 'household_key_invalid'],
      [4, 'invitee_name_invalid'],
    ]);
    expect(parsed.households).toEqual([]);
  });

  it('requires repeated household rows to agree on label and plus-one count', () => {
    expect(codes(file(
      'perkins,Perkins household,Henry Perkins,1',
      'perkins,Perkins family,Jordan Perkins,1',
    ))).toEqual(['household_label_inconsistent']);

    expect(codes(file(
      'perkins,Perkins household,Henry Perkins,1',
      'perkins,Perkins household,Jordan Perkins,2',
    ))).toEqual(['household_plus_one_inconsistent']);
  });

  it('rejects two rows in one household that normalize to the same name', () => {
    expect(parseRsvpCsv(file(
      'perkins,Perkins household,Henry Perkins,0',
      'perkins,Perkins household,  henry   perkins  ,0',
    )).issues).toEqual([
      expect.objectContaining({
        row: 3,
        field: 'invitee_name',
        code: 'household_duplicate_name',
      }),
    ]);
  });

  it('blocks two households that an exact name search cannot tell apart', () => {
    expect(parseRsvpCsv(file(
      'lee-a,Lee household,Alex Lee,0',
      'lee-b,Lee household,Alex Lee,0',
    )).issues).toEqual([
      expect.objectContaining({ row: 2, code: 'household_lookup_unresolvable' }),
      expect.objectContaining({ row: 3, code: 'household_lookup_unresolvable' }),
    ]);
  });

  it('allows a shared name when a second household member resolves it', () => {
    expect(codes(file(
      'lee-a,Lee household,Alex Lee,0',
      'lee-a,Lee household,Sam Lee,0',
      'lee-b,Lee household,Alex Lee,0',
      'lee-b,Lee household,Pat Lee,0',
    ))).toEqual([]);
  });

  it('accepts a household at exactly the named and plus-one limits', () => {
    const rows = Array.from(
      { length: 20 },
      (_unused, index) => `perkins,Perkins household,Guest Number ${index},10`,
    );
    const parsed = parseRsvpCsv(file(...rows));
    expect(parsed.issues).toEqual([]);
    expect(parsed.totals).toEqual({
      households: 1,
      namedInvitees: 20,
      plusOneCapacity: 10,
      invitedCapacity: 30,
    });
  });

  it('rejects a twenty-first named invitee in one household', () => {
    const rows = Array.from(
      { length: 21 },
      (_unused, index) => `perkins,Perkins household,Guest Number ${index},0`,
    );
    expect(codes(file(...rows))).toEqual(['household_named_limit']);
  });

  it('accepts exactly five hundred households at five hundred capacity', () => {
    const rows = Array.from(
      { length: 500 },
      (_unused, index) => `h${index},Household ${index},Guest Number ${index},0`,
    );
    const parsed = parseRsvpCsv(file(...rows));
    expect(parsed.issues).toEqual([]);
    expect(parsed.totals).toEqual({
      households: 500,
      namedInvitees: 500,
      plusOneCapacity: 0,
      invitedCapacity: 500,
    });
  });

  it('rejects a five-hundred-and-first household', () => {
    const rows = Array.from(
      { length: 501 },
      (_unused, index) => `h${index},Household ${index},Guest Number ${index},0`,
    );
    expect(codes(file(...rows))).toEqual(['event_household_limit']);
  });

  it('rejects a roster whose invited capacity exceeds the event limit', () => {
    const rows = Array.from(
      { length: 500 },
      (_unused, index) => `h${index},Household ${index},Guest Number ${index},${index === 0 ? 1 : 0}`,
    );
    expect(codes(file(...rows))).toEqual(['event_capacity_limit']);
  });

  it('marks every issue as blocking and carries guest-facing prose', () => {
    for (const issue of parseRsvpCsv(file('Perkins,Perkins household,Henry Perkins,0')).issues) {
      expect(issue.blocking).toBe(true);
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.message).not.toContain('undefined');
    }
  });
});

describe('formula-safe CSV output', () => {
  it.each([
    ['=1+1', "'=1+1"],
    [' +SUM(A1:A2)', "' +SUM(A1:A2)"],
    ['-cmd', "'-cmd"],
    ['@evil', "'@evil"],
    ['Avery', 'Avery'],
    ['Avery, Jr.', '"Avery, Jr."'],
  ])('encodes formula-safe cells', (input, output) => {
    expect(csvCell(input)).toBe(output);
  });

  it.each<[string, string | number | null, string]>([
    ['null as empty', null, ''],
    ['numbers unquoted', 64, '64'],
    ['a negative number', -1, "'-1"],
    ['embedded quotes', 'Maya, "laughing".png', '"Maya, ""laughing"".png"'],
    ['a newline', 'a\nb', '"a\nb"'],
    ['a carriage return', 'a\rb', '"a\rb"'],
    ['a tab-prefixed formula', '\t=1+1', "'\t=1+1"],
    ['a formula containing a comma', '=A1,B1', '"\'=A1,B1"'],
    ['diacritics untouched', 'Zoë', 'Zoë'],
  ])('encodes %s', (_label, input, output) => {
    expect(csvCell(input)).toBe(output);
  });
});

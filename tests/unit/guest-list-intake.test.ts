import { describe, expect, it } from 'vitest';

import {
  materializePlainGuests,
  materializeStructuredSource,
  parseGuestListSource,
  plainGuests,
  clientId,
  serializedBatchBytes,
  validateMapping,
} from '../../src/features/rsvp/guest-list-intake';

describe('guest-list intake helpers', () => {
  it('uses crypto UUIDs for every client address', () => {
    expect(clientId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('treats one-column CSV and lines as plain names', () => {
    expect(parseGuestListSource('Taylor Morgan\nAlex Morgan').kind).toBe('plain');
    expect(parseGuestListSource('Taylor Morgan\r\nAlex Morgan\r\n').kind).toBe('plain');
    expect(plainGuests('"Taylor, Morgan"\nAlex Morgan').map((guest) => guest.name))
      .toEqual(['Taylor, Morgan', 'Alex Morgan']);
  });

  it('treats rows with one non-empty cell and trailing delimiters as plain names', () => {
    const source = 'Taylor,\nAlex,';

    expect(parseGuestListSource(source).kind).toBe('plain');
    expect(plainGuests(source).map((guest) => guest.name)).toEqual(['Taylor', 'Alex']);
  });

  it('keeps stable people IDs when grouping and materializes ungrouped people individually', () => {
    const people = plainGuests('Taylor Morgan\nAlex Morgan\nJamie Lee');
    const batch = materializePlainGuests(people, [{
      id: '11111111-1111-4111-8111-111111111111',
      label: 'Morgan invitation',
      memberIds: [people[0]!.id, people[1]!.id],
    }]);

    expect(batch.creates).toHaveLength(2);
    expect(batch.creates[0]!.namedInvitees.map((invitee) => invitee.clientInviteeId))
      .toEqual([people[0]!.id, people[1]!.id]);
    expect(batch.creates[1]!.namedInvitees[0]!.clientInviteeId).toBe(people[2]!.id);
    expect(batch.creates[1]!.label).toBe('Jamie Lee');
  });

  it('measures the serialized preview envelope in UTF-8 bytes', () => {
    const batch = materializePlainGuests(plainGuests('李 雷'), []);
    expect(serializedBatchBytes(batch, 7)).toBe(
      new TextEncoder().encode(JSON.stringify({ batch, expectedRosterVersion: 7 })).byteLength,
    );
  });

  it('reports field-addressable structured mapping disagreements locally', () => {
    const parsed = parseGuestListSource('Guest,Household,Slots,Key\nA,Smith,1,s\nB,Smith,2,s\n');
    expect(validateMapping(parsed, { guestName: 0, household: 1, plusOneSlots: 2, householdKey: 3 }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ field: 'plusOneSlots' })]));
  });

  it('parses quoted CSV and tab-delimited rows including embedded newlines', () => {
    expect(parseGuestListSource('name,household\n"A, B","The\nHouse"\n').rows)
      .toEqual([['name', 'household'], ['A, B', 'The\nHouse']]);
    expect(parseGuestListSource('name\thousehold\r\nA\tSmith\r\n').rows)
      .toEqual([['name', 'household'], ['A', 'Smith']]);
    expect(parseGuestListSource('name\n"Taylor').error).toMatch(/unclosed/i);
  });

  it('keeps parsed source rows and structured client IDs stable while a mapping is corrected', () => {
    const parsed = parseGuestListSource('\uFEFFName,Household,Key\nTaylor,Morgan,morgan\nAlex,Morgan,morgan\n');
    const ids = new Map<string, string>();
    const first = materializeStructuredSource(parsed, {
      guestName: 0, household: 1, plusOneSlots: null, householdKey: 2,
    }, ids);
    const corrected = materializeStructuredSource(parsed, {
      guestName: 0, household: 1, plusOneSlots: null, householdKey: null,
    }, ids);

    expect(corrected.creates[0]?.clientHouseholdId).toBe(first.creates[0]?.clientHouseholdId);
    expect(corrected.creates[0]?.namedInvitees.map((invitee) => invitee.clientInviteeId))
      .toEqual(first.creates[0]?.namedInvitees.map((invitee) => invitee.clientInviteeId));
  });

  it('makes blank structured households stable individual invitations and catches mapping dependencies', () => {
    const parsed = parseGuestListSource('Guest,Household,Key\nTaylor,,morgan\nAlex,,rivera\n');
    const batch = materializeStructuredSource(parsed, {
      guestName: 0, household: 1, plusOneSlots: null, householdKey: 2,
    });
    expect(batch.creates).toHaveLength(2);
    expect(batch.creates.map((create) => create.label)).toEqual(['Taylor', 'Alex']);
    expect(validateMapping(parsed, {
      guestName: 0, household: null, plusOneSlots: null, householdKey: 2,
    })).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'householdKey' })]));
  });
});

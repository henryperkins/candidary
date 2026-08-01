import type { RsvpRosterBatchDraft } from '../../../shared/contracts';
import { MAX_PLUS_ONES_PER_HOUSEHOLD } from '../../../shared/constants';

export type GuestListSourceKind = 'plain' | 'structured' | 'ambiguous';
export type GuestListColumn = 'guestName' | 'household' | 'plusOneSlots' | 'householdKey';

export interface ParsedGuestListSource {
  rows: string[][];
  kind: GuestListSourceKind;
  strictHeader: boolean;
  firstRowIsHeader: boolean;
  error?: string;
}

export interface PlainGuest {
  id: string;
  name: string;
}

export interface GuestListGroup {
  id: string;
  label: string;
  memberIds: string[];
}

export interface GuestListMapping {
  guestName: number | null;
  household: number | null;
  plusOneSlots: number | null;
  householdKey: number | null;
}

export interface GuestListLocalIssue {
  field: GuestListColumn;
  message: string;
}

export function clientId(): string {
  return crypto.randomUUID();
}

function delimiterFor(input: string): ',' | '\t' {
  let quoted = false;
  let commas = 0;
  let tabs = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"') {
      if (quoted && input[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && character === ',') commas += 1;
    else if (!quoted && character === '\t') tabs += 1;
  }
  return tabs > commas ? '\t' : ',';
}

function hasExactlyOneNonEmptyCell(row: string[]): boolean {
  return row.filter((cell) => cell.length > 0).length === 1;
}

// This deliberately parses the small browser-only source rather than using
// `split`: spreadsheet cells may contain commas, CRLFs, and literal newlines.
export function parseGuestListSource(source: string): ParsedGuestListSource {
  const input = source.replace(/^\uFEFF/, '');
  const delimiter = delimiterFor(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  const finishCell = () => {
    row.push(value.trim());
    value = '';
  };
  const finishRow = () => {
    finishCell();
    if (row.some((cell) => cell.length > 0)) rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === delimiter) {
      finishCell();
      continue;
    }
    if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      finishRow();
      continue;
    }
    value += character;
  }

  if (quoted) {
    return {
      rows,
      kind: 'ambiguous',
      strictHeader: false,
      firstRowIsHeader: false,
      error: 'This source has an unclosed quoted value. Close the quote and try again.',
    };
  }
  if (value.length > 0 || row.length > 0) finishRow();

  const header = rows[0]?.map((cell) => cell.toLowerCase()) ?? [];
  const strictHeader = header.join(',') === 'household_key,household_label,invitee_name,plus_one_slots';
  const recognizedHeaders = new Set([
    'guest', 'guest name', 'name', 'invitee_name',
    'household', 'household label', 'household_label',
    'slots', 'plus-one slots', 'plus one slots', 'plus_one_slots',
    'key', 'household key', 'household_key',
  ]);
  const firstRowIsHeader = strictHeader || header.some((cell) => recognizedHeaders.has(cell));
  const widths = new Set(rows.map((candidate) => candidate.length));
  const kind: GuestListSourceKind = rows.length > 0 && rows.every(hasExactlyOneNonEmptyCell)
    ? 'plain'
    : rows.length === 0 || widths.size > 1
    ? 'ambiguous'
    : rows[0]?.length === 1 ? 'plain' : 'structured';
  return { rows, kind, strictHeader, firstRowIsHeader };
}

export function defaultMapping(parsed: ParsedGuestListSource): GuestListMapping {
  if (!parsed.firstRowIsHeader) {
    return { guestName: null, household: null, plusOneSlots: null, householdKey: null };
  }
  const header = parsed.rows[0]?.map((value) => value.toLowerCase()) ?? [];
  const column = (...names: string[]) => {
    const found = header.findIndex((value) => names.includes(value));
    return found < 0 ? null : found;
  };
  if (parsed.strictHeader) {
    return { guestName: 2, household: 1, plusOneSlots: 3, householdKey: 0 };
  }
  return {
    guestName: column('guest', 'guest name', 'name', 'invitee_name'),
    household: column('household', 'household label', 'household_label'),
    plusOneSlots: column('slots', 'plus-one slots', 'plus one slots', 'plus_one_slots'),
    householdKey: column('key', 'household key', 'household_key'),
  };
}

export function plainGuests(source: string): PlainGuest[] {
  const parsed = parseGuestListSource(source);
  const values = parsed.rows.every(hasExactlyOneNonEmptyCell)
    ? parsed.rows.map((row) => row.find((cell) => cell.length > 0) ?? '')
    // An intentional plain-name override must not silently drop the original
    // multi-cell lines. The server will still validate any unsuitable names.
    : source.replace(/^\uFEFF/, '').split(/\r\n?|\n/u);
  return values
    .filter(Boolean)
    .map((name) => ({ id: clientId(), name: name.trim() }))
    .filter((guest) => Boolean(guest.name));
}

function rememberedId(ids: Map<string, string>, key: string): string {
  const existing = ids.get(key);
  if (existing) return existing;
  const next = clientId();
  ids.set(key, next);
  return next;
}

export function materializePlainGuests(
  guests: PlainGuest[],
  groups: GuestListGroup[],
  individualIds = new Map<string, string>(),
): RsvpRosterBatchDraft {
  const people = new Map(guests.map((guest) => [guest.id, guest]));
  const grouped = new Set(groups.flatMap((group) => group.memberIds));
  const creates = groups.map((group) => ({
    clientHouseholdId: group.id,
    label: group.label,
    namedInvitees: group.memberIds.flatMap((id) => {
      const guest = people.get(id);
      return guest ? [{ clientInviteeId: guest.id, displayName: guest.name }] : [];
    }),
    plusOneSlots: 0,
  }));

  for (const guest of guests) {
    if (!grouped.has(guest.id)) {
      creates.push({
        clientHouseholdId: rememberedId(individualIds, `plain-individual:${guest.id}`),
        label: guest.name,
        namedInvitees: [{ clientInviteeId: guest.id, displayName: guest.name }],
        plusOneSlots: 0,
      });
    }
  }
  return { creates, appends: [] };
}

export function materializeStructuredSource(
  parsed: ParsedGuestListSource,
  mapping: GuestListMapping,
  ids = new Map<string, string>(),
): RsvpRosterBatchDraft {
  type Create = RsvpRosterBatchDraft['creates'][number];
  const createsByGroup = new Map<string, Create>();

  // Row positions are a source identity. They survive correcting column
  // mappings, whereas a display value may be deliberately changed by a mapper.
  const firstDataRow = parsed.firstRowIsHeader ? 1 : 0;
  for (let sourceIndex = firstDataRow; sourceIndex < parsed.rows.length; sourceIndex += 1) {
    const row = parsed.rows[sourceIndex]!;
    const name = mapping.guestName === null ? '' : (row[mapping.guestName] ?? '').trim();
    if (!name) continue;
    const household = mapping.household === null ? '' : (row[mapping.household] ?? '').trim();
    const key = mapping.householdKey === null ? '' : (row[mapping.householdKey] ?? '').trim();
    const rawSlots = mapping.plusOneSlots === null ? '' : (row[mapping.plusOneSlots] ?? '').trim();
    const plusOneSlots = rawSlots === '' ? 0 : Number(rawSlots);
    const groupKey = household ? `household:${household}` : `individual:${sourceIndex}`;
    const invitee = {
      clientInviteeId: rememberedId(ids, `structured-invitee:${sourceIndex}`),
      displayName: name,
    };
    const existing = createsByGroup.get(groupKey);
    if (existing) {
      existing.namedInvitees.push(invitee);
      if (key && !existing.householdKey) {
        existing.householdKey = { value: key, provenance: 'supplied' };
      }
      continue;
    }

    createsByGroup.set(groupKey, {
      // The earliest row gives a merged household a durable identity. If a
      // later mapping splits it again, that later row recovers its own identity.
      clientHouseholdId: rememberedId(ids, `structured-household:${sourceIndex}`),
      label: household || name,
      ...(household && key
        ? { householdKey: { value: key, provenance: 'supplied' as const } }
        : {}),
      namedInvitees: [invitee],
      plusOneSlots,
    });
  }
  return { creates: [...createsByGroup.values()], appends: [] };
}

export function validateMapping(
  parsed: ParsedGuestListSource,
  mapping: GuestListMapping,
): GuestListLocalIssue[] {
  const issues: GuestListLocalIssue[] = [];
  if (mapping.guestName === null) {
    issues.push({ field: 'guestName', message: 'Map a Guest name column before continuing.' });
  }
  if (mapping.householdKey !== null && mapping.household === null) {
    issues.push({ field: 'householdKey', message: 'Household key can be mapped only when Household is mapped.' });
  }
  const householdToKey = new Map<string, string>();
  const keyToHousehold = new Map<string, string>();
  const householdToSlots = new Map<string, string>();
  const rows = parsed.rows.slice(parsed.firstRowIsHeader ? 1 : 0);
  for (const row of rows) {
    if (mapping.plusOneSlots !== null) {
      const rawSlots = (row[mapping.plusOneSlots] ?? '').trim();
      const numericSlots = rawSlots === '' ? 0 : Number(rawSlots);
      if (!Number.isInteger(numericSlots) || numericSlots < 0 || numericSlots > MAX_PLUS_ONES_PER_HOUSEHOLD) {
        issues.push({
          field: 'plusOneSlots',
          message: `Plus-one slots must be a whole number from 0 to ${MAX_PLUS_ONES_PER_HOUSEHOLD}.`,
        });
        break;
      }
      if (mapping.household === null) continue;
      const household = (row[mapping.household] ?? '').trim();
      if (!household) continue;
      const slots = String(numericSlots);
      const previous = householdToSlots.get(household);
      if (previous !== undefined && previous !== slots) {
        issues.push({
          field: 'plusOneSlots',
          message: `Repeated household "${household}" has conflicting plus-one slots.`,
        });
        break;
      }
      householdToSlots.set(household, slots);
    }
    if (mapping.household === null) continue;
    const household = (row[mapping.household] ?? '').trim();
    if (!household) continue;
    if (mapping.householdKey !== null) {
      const key = (row[mapping.householdKey] ?? '').trim();
      if (!key) continue;
      const previousKey = householdToKey.get(household);
      const previousHousehold = keyToHousehold.get(key);
      if ((previousKey !== undefined && previousKey !== key)
        || (previousHousehold !== undefined && previousHousehold !== household)) {
        issues.push({
          field: 'householdKey',
          message: 'Each mapped Household and household key must have a one-to-one relationship.',
        });
        break;
      }
      householdToKey.set(household, key);
      keyToHousehold.set(key, household);
    }
  }
  return issues;
}

export function serializedBatchBytes(batch: RsvpRosterBatchDraft, expectedRosterVersion: number): number {
  return new TextEncoder().encode(JSON.stringify({ batch, expectedRosterVersion })).byteLength;
}

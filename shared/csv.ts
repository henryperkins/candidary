import { MAX_RSVP_CSV_BYTES } from './constants';
import type {
  RsvpImportField,
  RsvpImportIssue,
  RsvpImportIssueCode,
  RsvpImportTotals,
} from './contracts';
import {
  MAX_PLUS_ONES_PER_HOUSEHOLD,
  RSVP_HOUSEHOLD_KEY_PATTERN,
  checkHouseholdCapacity,
  checkRosterCapacity,
  findLookupCollisions,
  normalizeInvitedName,
  parsePersonText,
} from './rsvp';

const FORMULA_PREFIX = /^[\p{White_Space}]*[=+\-@]/u;

/**
 * Encodes one CSV cell for every export this product produces.
 *
 * A cell whose first non-whitespace character is `=`, `+`, `-`, or `@` is
 * prefixed with an apostrophe so a spreadsheet treats it as text rather than a
 * formula. Everything else is emitted byte-for-byte, quoted only when it has to
 * be, so ordinary exports are unchanged by this hardening.
 */
export function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  const safe = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe)
    ? `"${safe.replaceAll('"', '""')}"`
    : safe;
}

export const RSVP_CSV_HEADER = [
  'household_key',
  'household_label',
  'invitee_name',
  'plus_one_slots',
] as const;

const WHOLE_NUMBER = /^\d+$/u;
const BYTE_ORDER_MARK = 0xfeff;

export interface ParsedRsvpInvitee {
  displayName: string;
  normalizedName: string;
}

export interface ParsedRsvpHousehold {
  householdKey: string;
  label: string;
  plusOneSlots: number;
  invitees: ParsedRsvpInvitee[];
}

export interface ParsedRsvpRoster {
  households: ParsedRsvpHousehold[];
  issues: RsvpImportIssue[];
  totals: RsvpImportTotals;
}

const EMPTY_TOTALS: RsvpImportTotals = {
  households: 0,
  namedInvitees: 0,
  plusOneCapacity: 0,
  invitedCapacity: 0,
};

const MESSAGES: Record<RsvpImportIssueCode, string> = {
  file_too_large: 'That file is larger than 256 KB. Export just the guest list columns and try again.',
  file_empty: 'That file has a header but no guest rows.',
  header_invalid: 'The first line must be exactly: household_key,household_label,invitee_name,plus_one_slots',
  row_malformed: 'This line could not be read. Check for an unclosed quotation mark or a missing column.',
  household_key_invalid: 'Household keys use lowercase letters, numbers, hyphens, and underscores, up to 64 characters.',
  household_label_invalid: 'Household labels are 1 to 80 characters and cannot contain line breaks.',
  invitee_name_invalid: 'Guest names are 1 to 80 characters and cannot contain line breaks.',
  plus_one_slots_invalid: 'Plus-one slots must be a whole number from 0 to 10.',
  household_label_inconsistent: 'Every row for one household must repeat the same household label.',
  household_plus_one_inconsistent: 'Every row for one household must repeat the same plus-one count.',
  household_duplicate_name: 'This household already lists that name. Give each person their own name.',
  household_lookup_unresolvable: 'Another household has this same set of names, so a guest could not be told apart. Add a distinguishing name.',
  household_named_limit: 'A household can list at most 20 named guests.',
  household_capacity_limit: 'A household can hold at most 30 people including plus-one slots.',
  event_household_limit: 'This event can hold at most 500 households.',
  event_capacity_limit: 'This event can invite at most 500 people including plus-one slots.',
};

function issue(
  row: number,
  field: RsvpImportField,
  code: RsvpImportIssueCode,
): RsvpImportIssue {
  return { row, field, code, message: MESSAGES[code], blocking: true };
}

function failure(issues: RsvpImportIssue[]): ParsedRsvpRoster {
  return { households: [], issues, totals: { ...EMPTY_TOTALS } };
}

interface CsvGrid {
  rows: string[][];
  malformedLine: number | null;
}

/**
 * A hand-written RFC 4180 reader. Splitting on commas would corrupt any
 * household label containing one, and a host exporting from a spreadsheet will
 * produce those on their first try.
 */
function parseCsvGrid(text: string): CsvGrid {
  const source = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let fieldQuoted = false;
  let line = 1;

  const endField = (): void => {
    row.push(field);
    field = '';
    fieldQuoted = false;
    afterQuote = false;
  };

  const endRow = (): void => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    line += 1;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (inQuotes) {
      if (character !== '"') {
        field += character;
      } else if (source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = false;
        afterQuote = true;
      }
      continue;
    }

    if (character === '"') {
      // A quote may only open a field, and only before any other character.
      if (field !== '' || fieldQuoted || afterQuote) return { rows, malformedLine: line };
      inQuotes = true;
      fieldQuoted = true;
      continue;
    }

    if (character === ',') {
      endField();
      continue;
    }

    if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      endRow();
      continue;
    }

    // Anything other than a separator directly after a closing quote means the
    // row cannot be read unambiguously.
    if (afterQuote) return { rows, malformedLine: line };
    field += character;
  }

  if (inQuotes) return { rows, malformedLine: line };
  if (field !== '' || fieldQuoted || row.length > 0) endRow();
  return { rows, malformedLine: null };
}

interface HouseholdBuild {
  householdKey: string;
  label: string;
  plusOneSlots: number;
  firstLine: number;
  invitees: Array<{ displayName: string; normalizedName: string; line: number }>;
}

/**
 * Reads an uploaded roster into households, or into the complete list of
 * reasons it cannot be used. Issues carry the one-based file line they came
 * from: line 1 is the header, data starts at line 2, and line 0 means the file
 * as a whole.
 *
 * When anything blocks, no households are returned at all. A partial roster
 * with a count beside it would read as partial success, and this import is
 * all-or-nothing by design.
 */
export function parseRsvpCsv(csv: string): ParsedRsvpRoster {
  if (new TextEncoder().encode(csv).byteLength > MAX_RSVP_CSV_BYTES) {
    return failure([issue(0, 'file', 'file_too_large')]);
  }

  const grid = parseCsvGrid(csv);
  if (grid.malformedLine !== null) {
    return failure([issue(grid.malformedLine, 'file', 'row_malformed')]);
  }

  const header = grid.rows[0];
  if (!header || header.length !== RSVP_CSV_HEADER.length
    || RSVP_CSV_HEADER.some((column, index) => header[index]?.trim() !== column)) {
    return failure([issue(1, 'file', 'header_invalid')]);
  }
  if (grid.rows.length < 2) {
    return failure([issue(0, 'file', 'file_empty')]);
  }

  const malformed = grid.rows.findIndex(
    (candidate, index) => index > 0 && candidate.length !== RSVP_CSV_HEADER.length,
  );
  if (malformed > 0) {
    return failure([issue(malformed + 1, 'file', 'row_malformed')]);
  }

  interface DataRow {
    line: number;
    householdKey: string;
    label: string;
    displayName: string;
    normalizedName: string;
    plusOneSlots: number;
  }

  const fieldIssues: RsvpImportIssue[] = [];
  const dataRows: DataRow[] = [];

  for (let index = 1; index < grid.rows.length; index += 1) {
    const cells = grid.rows[index]!;
    const line = index + 1;
    const householdKey = cells[0]!.trim();
    const rawSlots = cells[3]!.trim();
    const label = parsePersonText(cells[1]!);
    const name = parsePersonText(cells[2]!);
    const plusOneSlots = Number(rawSlots);

    let rowFailed = false;
    if (!RSVP_HOUSEHOLD_KEY_PATTERN.test(householdKey)) {
      fieldIssues.push(issue(line, 'household_key', 'household_key_invalid'));
      rowFailed = true;
    }
    if (!label.ok) {
      fieldIssues.push(issue(line, 'household_label', 'household_label_invalid'));
      rowFailed = true;
    }
    if (!name.ok) {
      fieldIssues.push(issue(line, 'invitee_name', 'invitee_name_invalid'));
      rowFailed = true;
    }
    if (!WHOLE_NUMBER.test(rawSlots) || plusOneSlots > MAX_PLUS_ONES_PER_HOUSEHOLD) {
      fieldIssues.push(issue(line, 'plus_one_slots', 'plus_one_slots_invalid'));
      rowFailed = true;
    }
    if (rowFailed || !label.ok || !name.ok) continue;

    dataRows.push({
      line,
      householdKey,
      label: label.value,
      displayName: name.value,
      normalizedName: normalizeInvitedName(name.value),
      plusOneSlots,
    });
  }

  if (fieldIssues.length > 0) return failure(fieldIssues);

  const builds: HouseholdBuild[] = [];
  const byKey = new Map<string, HouseholdBuild>();
  const consistencyIssues: RsvpImportIssue[] = [];

  for (const dataRow of dataRows) {
    const existing = byKey.get(dataRow.householdKey);
    if (!existing) {
      const build: HouseholdBuild = {
        householdKey: dataRow.householdKey,
        label: dataRow.label,
        plusOneSlots: dataRow.plusOneSlots,
        firstLine: dataRow.line,
        invitees: [],
      };
      byKey.set(dataRow.householdKey, build);
      builds.push(build);
      build.invitees.push(dataRow);
      continue;
    }
    if (existing.label !== dataRow.label) {
      consistencyIssues.push(
        issue(dataRow.line, 'household_label', 'household_label_inconsistent'),
      );
    }
    if (existing.plusOneSlots !== dataRow.plusOneSlots) {
      consistencyIssues.push(
        issue(dataRow.line, 'plus_one_slots', 'household_plus_one_inconsistent'),
      );
    }
    existing.invitees.push(dataRow);
  }

  if (consistencyIssues.length > 0) return failure(consistencyIssues);

  const capacityIssues: RsvpImportIssue[] = [];
  for (const build of builds) {
    const capacity = checkHouseholdCapacity({
      namedCount: build.invitees.length,
      plusOneSlots: build.plusOneSlots,
    });
    if (capacity === 'household_named_limit') {
      const overflow = build.invitees[build.invitees.length - 1]!;
      capacityIssues.push(issue(overflow.line, 'invitee_name', 'household_named_limit'));
    } else if (capacity === 'household_capacity_limit') {
      capacityIssues.push(
        issue(build.firstLine, 'plus_one_slots', 'household_capacity_limit'),
      );
    }
  }

  const namedInvitees = builds.reduce((total, build) => total + build.invitees.length, 0);
  const plusOneCapacity = builds.reduce((total, build) => total + build.plusOneSlots, 0);
  const roster = checkRosterCapacity({
    households: builds.length,
    invitedCapacity: namedInvitees + plusOneCapacity,
  });
  if (roster) capacityIssues.push(issue(0, 'file', roster));
  if (capacityIssues.length > 0) return failure(capacityIssues);

  const collisions = findLookupCollisions(builds.map((build, index) => ({
    householdId: String(index),
    nameKeys: build.invitees.map((invitee) => invitee.normalizedName),
  })));

  if (collisions.length > 0) {
    // Map each collision back to a line. A duplicate is reported on the repeat
    // that caused it; an unresolvable name is reported where it first appears.
    const consumed = new Map<string, number>();
    const collisionIssues = collisions.map((collision) => {
      const build = builds[Number(collision.householdId)]!;
      const lines = build.invitees
        .filter((invitee) => invitee.normalizedName === collision.nameKey)
        .map((invitee) => invitee.line);
      if (collision.code !== 'household_duplicate_name') {
        return issue(lines[0]!, 'invitee_name', 'household_lookup_unresolvable');
      }
      const slot = (consumed.get(`${collision.householdId}:${collision.nameKey}`) ?? 0) + 1;
      consumed.set(`${collision.householdId}:${collision.nameKey}`, slot);
      return issue(lines[slot] ?? lines[lines.length - 1]!, 'invitee_name', 'household_duplicate_name');
    });
    return failure(collisionIssues);
  }

  return {
    households: builds.map((build) => ({
      householdKey: build.householdKey,
      label: build.label,
      plusOneSlots: build.plusOneSlots,
      invitees: build.invitees.map((invitee) => ({
        displayName: invitee.displayName,
        normalizedName: invitee.normalizedName,
      })),
    })),
    issues: [],
    totals: {
      households: builds.length,
      namedInvitees,
      plusOneCapacity,
      invitedCapacity: namedInvitees + plusOneCapacity,
    },
  };
}

import type { RsvpActor, RsvpAttendance, RsvpInviteeKind } from '../../shared/contracts';
import type { HouseholdNameKeys } from '../../shared/rsvp';
import type { RsvpHouseholdRecord, RsvpInviteeRecord } from './types';

// D1 refuses a statement binding more than 100 values, so a 500-person roster
// has to arrive as several parameter-bounded statements inside one batch rather
// than one enormous insert.
export const MAX_D1_BINDINGS = 100;

export type StatementBinding = string | number | null;

export interface StatementPlan {
  sql: string;
  bindings: StatementBinding[];
}

export interface RsvpHouseholdRow {
  id: string;
  event_id: string;
  household_key: string;
  label: string;
  version: number;
  last_submission_key: string | null;
  last_submission_digest: string | null;
  last_submission_result_version: number | null;
  first_responded_at: string | null;
  latest_responded_at: string | null;
  latest_actor_kind: RsvpActor | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RsvpInviteeRow {
  id: string;
  event_id: string;
  household_id: string;
  kind: RsvpInviteeKind;
  display_name: string | null;
  lookup_digest: string | null;
  attendance: RsvpAttendance;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function mapRsvpHousehold(row: RsvpHouseholdRow): RsvpHouseholdRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    householdKey: row.household_key,
    label: row.label,
    version: row.version,
    lastSubmissionKey: row.last_submission_key,
    lastSubmissionDigest: row.last_submission_digest,
    lastSubmissionResultVersion: row.last_submission_result_version,
    firstRespondedAt: row.first_responded_at,
    latestRespondedAt: row.latest_responded_at,
    latestActorKind: row.latest_actor_kind,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapRsvpInvitee(row: RsvpInviteeRow): RsvpInviteeRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    householdId: row.household_id,
    kind: row.kind,
    displayName: row.display_name,
    lookupDigest: row.lookup_digest,
    attendance: row.attendance,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const HOUSEHOLD_COLUMNS = [
  'id', 'event_id', 'household_key', 'label', 'created_at', 'updated_at',
] as const;

const INVITEE_COLUMNS = [
  'id', 'event_id', 'household_id', 'kind', 'display_name', 'lookup_digest',
  'sort_order', 'created_at', 'updated_at',
] as const;

function chunkedInsert(
  table: string,
  columns: readonly string[],
  rows: readonly StatementBinding[][],
): StatementPlan[] {
  const rowsPerStatement = Math.floor(MAX_D1_BINDINGS / columns.length);
  const plans: StatementPlan[] = [];
  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const slice = rows.slice(start, start + rowsPerStatement);
    const tuple = `(${columns.map(() => '?').join(', ')})`;
    plans.push({
      sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${slice.map(() => tuple).join(', ')}`,
      bindings: slice.flat(),
    });
  }
  return plans;
}

export interface RosterHouseholdInput {
  id: string;
  householdKey: string;
  label: string;
}

export interface RosterInviteeInput {
  id: string;
  householdId: string;
  kind: RsvpInviteeKind;
  displayName: string | null;
  lookupDigest: string | null;
  sortOrder: number;
}

/**
 * Turns a validated roster into parameter-bounded insert statements.
 *
 * Identifiers and ordering are decided by the caller before this runs, so the
 * statements are a pure function of their input and the whole import can be
 * handed to one `DB.batch()` that either lands completely or not at all.
 */
export function buildRosterStatements(input: {
  eventId: string;
  households: readonly RosterHouseholdInput[];
  invitees: readonly RosterInviteeInput[];
  createdAt: string;
}): StatementPlan[] {
  const households = input.households.map((household): StatementBinding[] => [
    household.id,
    input.eventId,
    household.householdKey,
    household.label,
    input.createdAt,
    input.createdAt,
  ]);
  const invitees = input.invitees.map((invitee): StatementBinding[] => [
    invitee.id,
    input.eventId,
    invitee.householdId,
    invitee.kind,
    invitee.displayName,
    invitee.lookupDigest,
    invitee.sortOrder,
    input.createdAt,
    input.createdAt,
  ]);
  return [
    ...chunkedInsert('rsvp_households', HOUSEHOLD_COLUMNS, households),
    ...chunkedInsert('rsvp_invitees', INVITEE_COLUMNS, invitees),
  ];
}

export class RsvpRepository {
  constructor(private readonly db: D1Database) {}

  toStatements(plans: readonly StatementPlan[]): D1PreparedStatement[] {
    return plans.map((plan) => this.db.prepare(plan.sql).bind(...plan.bindings));
  }

  // Counts archived households too. The first import may only run on an event
  // that has never had a roster, and an archived household is still history.
  async countHouseholds(eventId: string): Promise<number> {
    return await this.db
      .prepare('SELECT COUNT(*) AS count FROM rsvp_households WHERE event_id = ?')
      .bind(eventId).first<number>('count') ?? 0;
  }

  async getHousehold(eventId: string, id: string): Promise<RsvpHouseholdRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM rsvp_households WHERE event_id = ? AND id = ?')
      .bind(eventId, id).first<RsvpHouseholdRow>();
    return row ? mapRsvpHousehold(row) : null;
  }

  async listInvitees(eventId: string, householdId: string): Promise<RsvpInviteeRecord[]> {
    const rows = await this.db.prepare(`
      SELECT * FROM rsvp_invitees
      WHERE event_id = ? AND household_id = ?
      ORDER BY sort_order
    `).bind(eventId, householdId).all<RsvpInviteeRow>();
    return rows.results.map(mapRsvpInvitee);
  }

  /**
   * The named lookup digests of every active household, shaped for
   * `findLookupCollisions`. Plus-one slots are excluded because they carry no
   * digest and can never open an invitation.
   */
  async listActiveLookupKeys(eventId: string): Promise<HouseholdNameKeys[]> {
    const rows = await this.db.prepare(`
      SELECT household.id AS household_id, invitee.lookup_digest AS lookup_digest
      FROM rsvp_households AS household
      JOIN rsvp_invitees AS invitee
        ON invitee.event_id = household.event_id
       AND invitee.household_id = household.id
      WHERE household.event_id = ?
        AND household.archived_at IS NULL
        AND invitee.kind = 'named'
      ORDER BY household.created_at, household.id, invitee.sort_order
    `).bind(eventId).all<{ household_id: string; lookup_digest: string }>();

    const byHousehold = new Map<string, string[]>();
    const order: string[] = [];
    for (const row of rows.results) {
      const existing = byHousehold.get(row.household_id);
      if (existing) existing.push(row.lookup_digest);
      else {
        byHousehold.set(row.household_id, [row.lookup_digest]);
        order.push(row.household_id);
      }
    }
    return order.map((householdId) => ({
      householdId,
      nameKeys: byHousehold.get(householdId)!,
    }));
  }
}

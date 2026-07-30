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

/**
 * Applies one household's answers.
 *
 * The rows arrive as a single JSON binding read through `json_each`, so a
 * thirty-person household costs three bindings rather than ninety and can never
 * approach D1's parameter limit.
 *
 * Every condition that could make this write wrong is in the WHERE clause
 * rather than in a read before it: the household version, the event still being
 * open, the deadline, and the session's own captured window. A pause or a
 * deadline that lands mid-request therefore changes zero rows and the following
 * statement rolls the batch back, instead of being a race a read could lose.
 */
export const SUBMIT_INVITEES_SQL = `
  WITH submitted AS (
    SELECT
      json_extract(value, '$.id') AS id,
      json_extract(value, '$.attendance') AS attendance,
      json_extract(value, '$.displayName') AS display_name
    FROM json_each(?)
  )
  UPDATE rsvp_invitees
  SET attendance = (
        SELECT attendance FROM submitted WHERE submitted.id = rsvp_invitees.id
      ),
      display_name = CASE
        WHEN kind = 'named' THEN display_name
        WHEN (
          SELECT attendance FROM submitted WHERE submitted.id = rsvp_invitees.id
        ) = 'attending'
        THEN (
          SELECT display_name FROM submitted WHERE submitted.id = rsvp_invitees.id
        )
        ELSE NULL
      END,
      updated_at = ?
  WHERE event_id = ?
    AND household_id = ?
    AND id IN (SELECT id FROM submitted)
    AND (
      SELECT version FROM rsvp_households
      WHERE id = ? AND archived_at IS NULL
    ) = ?
    AND EXISTS (
      SELECT 1 FROM events
      WHERE id = rsvp_invitees.event_id
        AND deleted_at IS NULL
        AND rsvp_enabled = 1
        AND rsvp_deadline_at >= ?
    )
    AND EXISTS (
      SELECT 1 FROM rsvp_sessions
      WHERE id = ?
        AND event_id = rsvp_invitees.event_id
        AND household_id = rsvp_invitees.household_id
        AND revoked_at IS NULL
        AND expires_at >= ?
        AND write_authority_deadline >= ?
    )
`;

/**
 * A host correction. Same canonical write, but it answers to the manager's
 * authority rather than a household session, and deliberately ignores the guest
 * deadline: correcting a list after RSVP closes is the point.
 */
export const HOST_SUBMIT_INVITEES_SQL = `
  WITH submitted AS (
    SELECT
      json_extract(value, '$.id') AS id,
      json_extract(value, '$.attendance') AS attendance,
      json_extract(value, '$.displayName') AS display_name
    FROM json_each(?)
  )
  UPDATE rsvp_invitees
  SET attendance = (
        SELECT attendance FROM submitted WHERE submitted.id = rsvp_invitees.id
      ),
      display_name = CASE
        WHEN kind = 'named' THEN display_name
        WHEN (
          SELECT attendance FROM submitted WHERE submitted.id = rsvp_invitees.id
        ) = 'attending'
        THEN (
          SELECT display_name FROM submitted WHERE submitted.id = rsvp_invitees.id
        )
        ELSE NULL
      END,
      updated_at = ?
  WHERE event_id = ?
    AND household_id = ?
    AND id IN (SELECT id FROM submitted)
    AND (
      SELECT version FROM rsvp_households
      WHERE id = ? AND archived_at IS NULL
    ) = ?
    AND EXISTS (
      SELECT 1 FROM events WHERE id = rsvp_invitees.event_id AND deleted_at IS NULL
    )
`;

/**
 * Advances the household, or aborts the whole batch.
 *
 * `changes()` here is the invitee statement's row count. If it is not exactly
 * the number of rows that were meant to move, `version` is set to NULL and the
 * NOT NULL constraint tears the transaction down. A partially applied response
 * is not a state this product is willing to have.
 */
export const COMMIT_HOUSEHOLD_SQL = `
  UPDATE rsvp_households
  SET version = CASE WHEN changes() = ? THEN version + 1 ELSE NULL END,
      last_submission_key = ?,
      last_submission_digest = ?,
      last_submission_result_version = version + 1,
      first_responded_at = COALESCE(first_responded_at, ?),
      latest_responded_at = ?,
      latest_actor_kind = ?,
      updated_at = ?
  WHERE id = ? AND event_id = ? AND archived_at IS NULL AND version = ?
`;

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

  async getReceipt(
    householdId: string,
    idempotencyKey: string,
  ): Promise<{ requestDigest: string; resultVersion: number } | null> {
    const row = await this.db.prepare(`
      SELECT request_digest, result_version FROM rsvp_submission_receipts
      WHERE household_id = ? AND idempotency_key = ?
    `).bind(householdId, idempotencyKey)
      .first<{ request_digest: string; result_version: number }>();
    return row ? { requestDigest: row.request_digest, resultVersion: row.result_version } : null;
  }

  receiptStatement(input: {
    eventId: string;
    householdId: string;
    idempotencyKey: string;
    requestDigest: string;
    resultVersion: number;
    createdAt: string;
  }): D1PreparedStatement {
    return this.db.prepare(`
      INSERT INTO rsvp_submission_receipts (
        event_id, household_id, idempotency_key, request_digest, result_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      input.eventId,
      input.householdId,
      input.idempotencyKey,
      input.requestDigest,
      input.resultVersion,
      input.createdAt,
    );
  }

  /**
   * The active households holding a given named-guest digest.
   *
   * Queries the digest alone — never a name, never a prefix — so this cannot be
   * walked to enumerate a roster.
   */
  async householdsByLookupDigest(eventId: string, lookupDigest: string): Promise<string[]> {
    const rows = await this.db.prepare(`
      SELECT DISTINCT household.id AS household_id
      FROM rsvp_invitees AS invitee
      JOIN rsvp_households AS household
        ON household.event_id = invitee.event_id
       AND household.id = invitee.household_id
      WHERE invitee.event_id = ?
        AND invitee.lookup_digest = ?
        AND invitee.kind = 'named'
        AND household.archived_at IS NULL
      ORDER BY household.id
    `).bind(eventId, lookupDigest).all<{ household_id: string }>();
    return rows.results.map((row) => row.household_id);
  }

  /**
   * How many named guests and plus-one slots each active household holds.
   *
   * A LEFT JOIN, so a household with no invitees at all still appears: that is
   * exactly the shape RSVP activation has to refuse.
   */
  async listHouseholdCompositions(eventId: string): Promise<Array<{
    householdId: string;
    namedCount: number;
    plusOneCount: number;
  }>> {
    const rows = await this.db.prepare(`
      SELECT household.id AS household_id,
             SUM(CASE WHEN invitee.kind = 'named' THEN 1 ELSE 0 END) AS named_count,
             SUM(CASE WHEN invitee.kind = 'plus_one' THEN 1 ELSE 0 END) AS plus_one_count
      FROM rsvp_households AS household
      LEFT JOIN rsvp_invitees AS invitee
        ON invitee.event_id = household.event_id
       AND invitee.household_id = household.id
      WHERE household.event_id = ? AND household.archived_at IS NULL
      GROUP BY household.id
      ORDER BY household.created_at, household.id
    `).bind(eventId).all<{
      household_id: string;
      named_count: number | null;
      plus_one_count: number | null;
    }>();
    return rows.results.map((row) => ({
      householdId: row.household_id,
      namedCount: row.named_count ?? 0,
      plusOneCount: row.plus_one_count ?? 0,
    }));
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

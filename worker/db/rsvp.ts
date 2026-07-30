import type {
  RsvpActor,
  RsvpAttendance,
  RsvpHouseholdFilter,
  RsvpInviteeKind,
} from '../../shared/contracts';
import type { RsvpHouseholdCursor } from '../http/rsvp-cursor';
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

export interface RsvpHouseholdListRow {
  id: string;
  household_key: string;
  label: string;
  version: number;
  archived_at: string | null;
  attending: number;
  declined: number;
  awaiting_response: number;
  invited_capacity: number;
  first_responded_at: string | null;
  latest_responded_at: string | null;
  latest_actor_kind: RsvpActor | null;
  updated_at: string;
}

export interface RsvpExportRowRecord {
  household_key: string;
  household_label: string;
  household_archived_at: string | null;
  member_kind: RsvpInviteeKind;
  member_name: string | null;
  attendance: RsvpAttendance;
  member_order: number;
  household_version: number;
  first_responded_at: string | null;
  last_responded_at: string | null;
  last_actor: RsvpActor | null;
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

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

const HOUSEHOLD_COLUMNS = [
  'id', 'event_id', 'household_key', 'label', 'created_at', 'updated_at',
] as const;

const INVITEE_COLUMNS = [
  'id', 'event_id', 'household_id', 'kind', 'display_name', 'lookup_digest',
  'sort_order', 'created_at', 'updated_at',
] as const;

const MANAGED_INVITEE_COLUMNS = [
  'id', 'event_id', 'household_id', 'kind', 'display_name', 'lookup_digest',
  'attendance', 'sort_order', 'created_at', 'updated_at',
] as const;

export function chunkedInsert(
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

export interface ManagedInviteeInput extends RosterInviteeInput {
  attendance: RsvpAttendance;
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

export function buildManagedInviteeInsertStatements(input: {
  eventId: string;
  invitees: readonly ManagedInviteeInput[];
  createdAt: string;
}): StatementPlan[] {
  return chunkedInsert(
    'rsvp_invitees',
    MANAGED_INVITEE_COLUMNS,
    input.invitees.map((invitee): StatementBinding[] => [
      invitee.id,
      input.eventId,
      invitee.householdId,
      invitee.kind,
      invitee.displayName,
      invitee.lookupDigest,
      invitee.attendance,
      invitee.sortOrder,
      input.createdAt,
      input.createdAt,
    ]),
  );
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
  SET version = CASE
        WHEN changes() = ? AND version = ? AND archived_at IS NULL
        THEN version + 1
        ELSE NULL
      END,
      last_submission_key = ?,
      last_submission_digest = ?,
      last_submission_result_version = version + 1,
      first_responded_at = COALESCE(first_responded_at, ?),
      latest_responded_at = ?,
      latest_actor_kind = ?,
      updated_at = ?
  WHERE id = ? AND event_id = ?
`;

/**
 * Every host mutation advances the event-level roster version first. A stale
 * page sets the NOT NULL column to NULL, aborting the complete D1 batch before
 * any household row can move.
 */
export const ADVANCE_ROSTER_SQL = `
  UPDATE events
  SET rsvp_roster_version = CASE
        WHEN rsvp_roster_version = ? AND deleted_at IS NULL
        THEN rsvp_roster_version + 1
        ELSE NULL
      END
  WHERE id = ?
`;

/**
 * The household half of a host roster edit. It deliberately targets the row
 * even when stale or archived so the NOT NULL guard executes and rolls the
 * event-version advance back.
 */
export const UPDATE_HOUSEHOLD_ROSTER_SQL = `
  UPDATE rsvp_households
  SET version = CASE
        WHEN version = ? AND archived_at IS NULL THEN version + 1
        ELSE NULL
      END,
      label = ?,
      updated_at = ?
  WHERE id = ? AND event_id = ?
`;

export const ARCHIVE_HOUSEHOLD_SQL = `
  UPDATE rsvp_households
  SET version = CASE
        WHEN version = ? AND archived_at IS NULL THEN version + 1
        ELSE NULL
      END,
      archived_at = ?,
      updated_at = ?
  WHERE id = ? AND event_id = ?
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

  async getHouseholdByKey(
    eventId: string,
    householdKey: string,
  ): Promise<RsvpHouseholdRecord | null> {
    const row = await this.db.prepare(`
      SELECT * FROM rsvp_households WHERE event_id = ? AND household_key = ?
    `).bind(eventId, householdKey).first<RsvpHouseholdRow>();
    return row ? mapRsvpHousehold(row) : null;
  }

  async listHouseholds(eventId: string): Promise<RsvpHouseholdRecord[]> {
    const rows = await this.db.prepare(`
      SELECT * FROM rsvp_households
      WHERE event_id = ?
      ORDER BY created_at, id
    `).bind(eventId).all<RsvpHouseholdRow>();
    return rows.results.map(mapRsvpHousehold);
  }

  async listInvitees(eventId: string, householdId: string): Promise<RsvpInviteeRecord[]> {
    const rows = await this.db.prepare(`
      SELECT * FROM rsvp_invitees
      WHERE event_id = ? AND household_id = ?
      ORDER BY sort_order
    `).bind(eventId, householdId).all<RsvpInviteeRow>();
    return rows.results.map(mapRsvpInvitee);
  }

  async listEventInvitees(eventId: string): Promise<RsvpInviteeRecord[]> {
    const rows = await this.db.prepare(`
      SELECT invitee.*
      FROM rsvp_invitees AS invitee
      JOIN rsvp_households AS household
        ON household.event_id = invitee.event_id
       AND household.id = invitee.household_id
      WHERE invitee.event_id = ?
      ORDER BY household.created_at, household.id, invitee.sort_order
    `).bind(eventId).all<RsvpInviteeRow>();
    return rows.results.map(mapRsvpInvitee);
  }

  async listManagerHouseholds(input: {
    eventId: string;
    query?: string;
    state: RsvpHouseholdFilter;
    cursor?: RsvpHouseholdCursor;
    limit: number;
  }): Promise<RsvpHouseholdListRow[]> {
    const where = ['household.event_id = ?'];
    const bindings: StatementBinding[] = [input.eventId];

    if (input.state === 'archived') {
      where.push('household.archived_at IS NOT NULL');
    } else {
      where.push('household.archived_at IS NULL');
      if (input.state === 'responded') {
        where.push(`NOT EXISTS (
          SELECT 1 FROM rsvp_invitees AS pending
          WHERE pending.event_id = household.event_id
            AND pending.household_id = household.id
            AND pending.attendance = 'pending'
        )`);
      } else if (input.state === 'awaiting') {
        where.push(`EXISTS (
          SELECT 1 FROM rsvp_invitees AS pending
          WHERE pending.event_id = household.event_id
            AND pending.household_id = household.id
            AND pending.attendance = 'pending'
        )`);
      }
    }

    if (input.query !== undefined && input.query.length > 0) {
      const pattern = `%${escapeLike(input.query)}%`;
      where.push(`(
        household.label LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM rsvp_invitees AS matched
          WHERE matched.event_id = household.event_id
            AND matched.household_id = household.id
            AND matched.display_name IS NOT NULL
            AND matched.display_name LIKE ? ESCAPE '\\'
        )
      )`);
      bindings.push(pattern, pattern);
    }

    if (input.cursor) {
      where.push(`(
        household.updated_at < ?
        OR (household.updated_at = ? AND household.id < ?)
      )`);
      bindings.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id);
    }

    bindings.push(input.limit);
    const rows = await this.db.prepare(`
      SELECT
        household.id,
        household.household_key,
        household.label,
        household.version,
        household.archived_at,
        household.first_responded_at,
        household.latest_responded_at,
        household.latest_actor_kind,
        household.updated_at,
        (
          SELECT COUNT(*) FROM rsvp_invitees AS member
          WHERE member.event_id = household.event_id
            AND member.household_id = household.id
            AND member.attendance = 'attending'
        ) AS attending,
        (
          SELECT COUNT(*) FROM rsvp_invitees AS member
          WHERE member.event_id = household.event_id
            AND member.household_id = household.id
            AND member.attendance = 'declined'
        ) AS declined,
        (
          SELECT COUNT(*) FROM rsvp_invitees AS member
          WHERE member.event_id = household.event_id
            AND member.household_id = household.id
            AND member.attendance = 'pending'
        ) AS awaiting_response,
        (
          SELECT COUNT(*) FROM rsvp_invitees AS member
          WHERE member.event_id = household.event_id
            AND member.household_id = household.id
        ) AS invited_capacity
      FROM rsvp_households AS household
      WHERE ${where.join('\n AND ')}
      ORDER BY household.updated_at DESC, household.id DESC
      LIMIT ?
    `).bind(...bindings).all<RsvpHouseholdListRow>();
    return rows.results;
  }

  async listExportRows(eventId: string): Promise<RsvpExportRowRecord[]> {
    const rows = await this.db.prepare(`
      SELECT
        household.household_key,
        household.label AS household_label,
        household.archived_at AS household_archived_at,
        invitee.kind AS member_kind,
        invitee.display_name AS member_name,
        invitee.attendance,
        invitee.sort_order AS member_order,
        household.version AS household_version,
        household.first_responded_at,
        household.latest_responded_at AS last_responded_at,
        household.latest_actor_kind AS last_actor
      FROM rsvp_households AS household
      JOIN rsvp_invitees AS invitee
        ON invitee.event_id = household.event_id
       AND invitee.household_id = household.id
      WHERE household.event_id = ?
      ORDER BY household.created_at, household.id, invitee.sort_order
    `).bind(eventId).all<RsvpExportRowRecord>();
    return rows.results;
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

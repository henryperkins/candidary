/**
 * The canonical cover-backfill dispatch predicates, written once.
 *
 * Two callers claim and confirm the same dispatch generation from opposite
 * sides: the Node launcher emits SQL an operator applies through Wrangler, and
 * the Worker runs the same transitions itself as the crash-safe backstop. If
 * either side's guard were even slightly weaker than the other's, the weaker one
 * would become the real contract — an operator artifact that confirms a fence
 * the Worker would have refused is exactly how a purged event gets written into.
 * So neither side owns these predicates; this module does, and both render the
 * same strings.
 *
 * Every builder takes already-rendered SQL *values* rather than raw data,
 * because the two callers cannot bind the same way. The Worker passes numbered
 * placeholders (`?1`, `?2`, …) and binds them; the launcher passes quoted
 * literals, since a generated artifact has to be reviewable as text before an
 * operator runs it. The predicate structure is identical either way, and that is
 * the property worth protecting.
 *
 * Dependency-free on purpose. `scripts/` runs under Node's native type
 * stripping, which cannot resolve the extensionless relative imports the rest of
 * `shared/` uses, so this module must import nothing to stay loadable from
 * there. See the same constraint on `shared/constants.ts`.
 */

/** Immutable from `0012` onward: it is written into every backfill fence row. */
export const COVER_BACKFILL_WORKFLOW_BINDING = 'COVER_BACKFILL_WORKFLOW';

/** A job that still occupies ledger capacity. */
export const NONTERMINAL_COVER_BACKFILL_STATUSES = [
  'queued', 'normalizing', 'rendering', 'finalizing',
] as const;

/**
 * A job that occupies *platform* capacity.
 *
 * Deliberately not the same set as the nonterminal statuses. A `pending` job is
 * queued in the ledger and has no instance behind it, so counting it as in
 * flight would make a run of more than twenty-five jobs refuse its own first
 * dispatch forever. In flight means a claim has been made and not yet settled.
 */
export const LIVE_COVER_DISPATCH_STATES = [
  'creating', 'confirmed', 'resuming', 'restarting',
] as const;

/** The rolling creation window, measured by the database's clock, never the caller's. */
export const ROLLING_CLAIM_WINDOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')";

/**
 * The instant a claim is *applied*, on the same clock the window above is read
 * from, and the only value that may be written into the dispatch-claim column.
 *
 * The window and the column it filters have to come from one clock or the bound
 * measures nothing. `values.now` is stamped when an artifact is *generated* — the
 * operator then runs two identity checks, reads twenty-five trigger commands and
 * applies the file, which is minutes later on a good day. Writing that instant
 * into `updated_at` would make every rolling-minute predicate compare the
 * database's now against the launcher's then, so the budget would report a full
 * minute of headroom however many claims had just landed, and a workstation
 * clock a minute slow would disable it outright.
 *
 * Emits exactly `YYYY-MM-DDTHH:MM:SS.sssZ`, so it stays byte-comparable with the
 * `toISOString()` values the rest of the schema stores.
 */
export const CLAIM_APPLIED_AT_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export interface CoverDispatchSqlValues {
  /** The workflow binding name, rendered as a value. */
  binding: string;
  runId: string;
  jobId: string;
  eventId: string;
  /** The generation this unit claims, rendered as a value. */
  generation: string;
  now: string;
}

export interface CoverDispatchBounds {
  inFlight: number;
  perMinute: number;
}

function quotedList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

const NONTERMINAL = quotedList(NONTERMINAL_COVER_BACKFILL_STATUSES);
const LIVE_DISPATCH = quotedList(LIVE_COVER_DISPATCH_STATES);

/**
 * The fence that authorizes this generation.
 *
 * Correlated against the job row rather than against a passed-in instance ID, so
 * the fence is always the one belonging to the job being written — an artifact
 * cannot be edited to point a confirmation at somebody else's fence.
 */
function fenceGuard(binding: string, state: string, generation: string | null): string {
  return 'EXISTS (SELECT 1 FROM event_cover_workflow_fences f'
    + ` WHERE f.workflow_binding = ${binding}`
    + ' AND f.workflow_instance_id = event_cover_backfill_jobs.workflow_instance_id'
    + ' AND f.event_id = event_cover_backfill_jobs.event_id'
    + ` AND f.state = '${state}'`
    + (generation === null ? '' : ` AND f.dispatch_generation = ${generation}`)
    + ')';
}

function liveEventGuard(): string {
  return 'EXISTS (SELECT 1 FROM events e'
    + ' WHERE e.id = event_cover_backfill_jobs.event_id AND e.deleted_at IS NULL)';
}

/** One job and its fence, read together. The only input a confirmation may use. */
export function coverDispatchReadSql(values: {
  binding: string; runId: string; jobId: string; eventId: string;
}): string {
  return [
    "SELECT 'confirm' AS kind, j.run_id AS run_id, j.id AS job_id,",
    ' j.event_id AS event_id, j.workflow_instance_id AS workflow_instance_id,',
    ' j.dispatch_state AS dispatch_state, j.dispatch_generation AS dispatch_generation,',
    ' j.status AS status, f.state AS fence_state, f.dispatch_generation AS fence_generation',
    ' FROM event_cover_backfill_jobs j',
    ' LEFT JOIN event_cover_workflow_fences f',
    `   ON f.workflow_binding = ${values.binding}`,
    '  AND f.workflow_instance_id = j.workflow_instance_id AND f.event_id = j.event_id',
    ` WHERE j.id = ${values.jobId} AND j.run_id = ${values.runId}`,
    ` AND j.event_id = ${values.eventId}`,
  ].join('');
}

/**
 * `pending → creating`, incrementing the generation, with all four refusals.
 *
 * Every bound is re-evaluated here rather than trusted from the read that
 * produced the artifact. A generated claim can sit in a terminal for minutes
 * before an operator runs it, and the whole point of putting the bounds in SQL
 * is that the database decides at apply time whether they still hold.
 *
 * The fence statement carries `changes() = 1`, so the fence moves only when the
 * job actually moved. Its `updated_at` becomes the durable dispatch-claim clock
 * that the rolling-minute predicates below read, and is therefore stamped from
 * the database's own clock rather than from `values.now`; confirmation must
 * never rewrite it.
 */
export function claimCoverBackfillDispatchSql(
  values: CoverDispatchSqlValues & { workflowInstanceId: string },
  bounds: CoverDispatchBounds,
): { job: string; fence: string } {
  const claimedInLastMinute = 'NOT EXISTS (SELECT 1 FROM event_cover_workflow_fences f'
    + ` WHERE f.workflow_binding = ${values.binding}`
    + ` AND f.workflow_instance_id = ${values.workflowInstanceId}`
    + ' AND f.dispatch_generation > 0'
    + ` AND f.updated_at >= ${ROLLING_CLAIM_WINDOW_SQL})`;
  const minuteBudget = '(SELECT count(*) FROM event_cover_workflow_fences f'
    + ` WHERE f.workflow_binding = ${values.binding}`
    + " AND f.state = 'open' AND f.dispatch_generation > 0"
    + ` AND f.updated_at >= ${ROLLING_CLAIM_WINDOW_SQL}) < ${bounds.perMinute}`;
  const inFlightBudget = '(SELECT count(*) FROM event_cover_backfill_jobs j'
    + ` WHERE j.run_id = ${values.runId}`
    + ` AND j.dispatch_state IN (${LIVE_DISPATCH})`
    + ` AND j.status IN (${NONTERMINAL})) < ${bounds.inFlight}`;
  const noOtherActiveRun = 'NOT EXISTS (SELECT 1 FROM event_cover_backfill_runs r'
    + ` WHERE r.id <> ${values.runId} AND r.status IN ('inventorying', 'executing'))`;

  return {
    job: 'UPDATE event_cover_backfill_jobs'
      + " SET dispatch_state = 'creating', dispatch_generation = dispatch_generation + 1,"
      + ` updated_at = ${values.now}`
      + ` WHERE id = ${values.jobId} AND run_id = ${values.runId} AND event_id = ${values.eventId}`
      + ` AND dispatch_state = 'pending' AND status = 'queued'`
      + ` AND dispatch_generation = ${values.generation}`
      + ` AND ${liveEventGuard()}`
      + ' AND NOT EXISTS (SELECT 1 FROM event_cover_purge_progress p'
      + '   WHERE p.event_id = event_cover_backfill_jobs.event_id)'
      + ` AND ${fenceGuard(values.binding, 'open', values.generation)}`
      + ` AND ${noOtherActiveRun}`
      + ` AND ${inFlightBudget}`
      + ` AND ${claimedInLastMinute}`
      + ` AND ${minuteBudget}`,
    fence: 'UPDATE event_cover_workflow_fences'
      + ' SET dispatch_generation = (SELECT j.dispatch_generation'
      + `   FROM event_cover_backfill_jobs j WHERE j.id = ${values.jobId}),`
      + ` updated_at = ${CLAIM_APPLIED_AT_SQL}`
      + ` WHERE workflow_binding = ${values.binding}`
      + ` AND workflow_instance_id = ${values.workflowInstanceId}`
      + ` AND event_id = ${values.eventId} AND state = 'open' AND changes() = 1`,
  };
}

/**
 * `creating → confirmed` for exactly one generation.
 *
 * Rechecks the fence and the event inside the statement, so a deletion that
 * lands between the post-trigger read and the apply records no success. It does
 * not touch the fence: the fence's `updated_at` is the dispatch-claim clock the
 * rolling-minute budget is measured from, and rewriting it here would hand the
 * next batch a minute of capacity it never earned.
 */
export function confirmCoverBackfillDispatchSql(values: CoverDispatchSqlValues): string {
  return 'UPDATE event_cover_backfill_jobs'
    + ` SET dispatch_state = 'confirmed', updated_at = ${values.now}`
    + ` WHERE id = ${values.jobId} AND run_id = ${values.runId} AND event_id = ${values.eventId}`
    + ` AND dispatch_state = 'creating' AND dispatch_generation = ${values.generation}`
    + ` AND ${fenceGuard(values.binding, 'open', values.generation)}`
    + ` AND ${liveEventGuard()}`;
}

/**
 * The settlement a purge-owned fence earns.
 *
 * Terminal and not retryable: the event is being deleted, so there is nothing to
 * restart into. Guarded on the fence still being blocked, so a purge that was
 * itself rolled back cannot be finished by a stale artifact.
 */
export function blockCoverBackfillDispatchSql(values: CoverDispatchSqlValues): string {
  return 'UPDATE event_cover_backfill_jobs'
    + " SET dispatch_state = 'blocked', status = 'failed', retryable = 0,"
    + ` failure_code = 'EVENT_DELETED', terminal_at = ${values.now}, updated_at = ${values.now}`
    + ` WHERE id = ${values.jobId} AND run_id = ${values.runId} AND event_id = ${values.eventId}`
    + ` AND dispatch_generation = ${values.generation}`
    + ` AND status IN (${NONTERMINAL})`
    + ` AND ${fenceGuard(values.binding, 'deletion-blocked', null)}`;
}

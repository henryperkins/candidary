import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as ConstantsModule from '../shared/constants';
import type * as CoverDispatchModule from '../shared/cover-dispatch';

/**
 * The legacy-cover backfill launcher: inventory, execute, dispatch, confirm, verify.
 *
 * A planner, not a driver — the same shape as `scripts/event-start-backfill.ts`.
 * It reads `wrangler d1 execute --json` output and emits the exact SQL and
 * instance-create commands an operator then runs. Nothing here opens a
 * connection, mutates a database, or creates a Workflow instance, which is what
 * makes every bound below testable without a network and what keeps a mistyped
 * flag from being a production event.
 *
 * D1 is the durable source of truth, and the five modes exist to keep it that
 * way. `inventory` and `execute` only ever write the ledger; they never propose
 * a Workflow command, because a job ID that lost its `NOT EXISTS` guard must
 * never be triggerable. `dispatch` reads the committed rows back and can emit a
 * command only for a row D1 returned. `confirm` consumes the post-trigger read
 * for one generation and emits a guarded confirmation, a terminate/failure
 * unit, or nothing at all. `verify` prints the proof and, under its own gate,
 * opens a verification run — it can never record one as verified.
 *
 * Mutating output is emitted only when `CANDIDARY_COVER_BACKFILL_CONFIRM` is
 * set, mirroring the load harnesses; without it a mode prints the plan it
 * *would* emit and stops.
 *
 * Four bounds are enforced here rather than trusted to an operator's patience:
 * at most one page of inventory, at most one 25-instance batch, never more than
 * 25 jobs nonterminal, and never more than 25 creates in a minute. Every one of
 * them is now charged against a committed D1 read rather than a constant.
 */

const constantsModulePath = '../shared/constants.ts';
const constants = await import(constantsModulePath) as typeof ConstantsModule;
/**
 * The claim and confirmation predicates the Worker also renders. Loaded the same
 * way `constants` is, because Node's type stripping cannot follow the
 * extensionless imports the rest of `shared/` uses.
 */
const coverDispatchModulePath = '../shared/cover-dispatch.ts';
const dispatch = await import(coverDispatchModulePath) as typeof CoverDispatchModule;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Raw payloads carry object keys and must never reach a commit. `output/` is
 * the repository's ignored scratch directory, so an artifact path that lands
 * inside the checkout has to land there.
 */
const ARTIFACT_ROOT = resolve(PROJECT_ROOT, 'output');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const INSTANCE_ID_PATTERN = /^cb1-[0-9a-f]{48}$/u;
const ROLLING_MINUTE_MS = 60 * 1000;
const FENCE_TTL_MS = 31 * 24 * 60 * 60 * 1000;
const DISPATCH_ARTIFACT_KIND = 'candidary-cover-backfill-dispatch' as const;
const EXECUTE_ARTIFACT_KIND = 'candidary-cover-backfill-execute' as const;
const CONFIRM_ARTIFACT_KIND = 'candidary-cover-backfill-confirm' as const;
const ARTIFACT_VERSION = 2 as const;

export const COVER_BACKFILL_WORKFLOW_NAME = 'candidary-cover-backfill';
export const COVER_BACKFILL_BINDING = dispatch.COVER_BACKFILL_WORKFLOW_BINDING;
export const COVER_BACKFILL_DATABASE_NAME = 'candidary-core';
export const COVER_BACKFILL_DATABASE_ID = '60bec5de-c8c7-41b5-a26b-2d3f7d184c71';
export const COVER_BACKFILL_WORKER_NAME = 'candidary';
export const WRANGLER_CONFIG_PATH = 'wrangler.jsonc';

/**
 * The nine source-independent version axes pinned into every job row.
 *
 * Restated rather than imported for the same reason the preset generator
 * restates its registry: `shared/event-cover.ts` imports `./constants` without
 * an extension and cannot be loaded by Node's type stripping.
 * `tests/unit/cover-backfill-launcher.test.ts` asserts this record against
 * `COVER_PIPELINE_VERSIONS` itself, and `tests/worker/cover-backfill-workflow.test.ts`
 * asserts the Worker's copy against the same source, so both ends are pinned to
 * the contract rather than to each other.
 */
export const COVER_BACKFILL_DEPENDENCY_VERSIONS = {
  normalizationLadder: 1,
  imagesParameterRecipe: 1,
  matte: 1,
  metadataPolicy: 1,
  compositionModel: 1,
  cropProfileRegistry: 1,
  tonalEffect: 1,
  sharpening: 1,
  outputQualityLadder: 1,
} as const;

/**
 * `worker/db/types.ts` is in a different build project, and Node's type
 * stripping cannot follow the extensionless imports beneath it, so the three
 * vocabularies are restated here. The launcher test parses `0012`'s CHECK
 * constraints and asserts these arrays against them, which pins the copy to the
 * schema itself rather than to the Worker's copy of it.
 */
export const COVER_DISPATCH_STATES = [
  'pending', 'creating', 'confirmed', 'resuming', 'restarting', 'failed', 'blocked',
] as const;
export const COVER_BACKFILL_JOB_STATUSES = [
  'queued', 'normalizing', 'rendering', 'finalizing', 'applied',
  'skipped', 'resolved', 'needs_replacement', 'failed',
] as const;
export const COVER_FENCE_STATES = ['open', 'deletion-blocked'] as const;
export const COVER_BACKFILL_RUN_STATUSES = [
  'inventorying', 'executing', 'verified', 'failed',
] as const;
export const COVER_BACKFILL_RUN_MODES = ['inventory', 'execute', 'verify'] as const;

/** The statuses that still occupy ledger capacity. */
export const NONTERMINAL_JOB_STATUSES = dispatch.NONTERMINAL_COVER_BACKFILL_STATUSES;
/**
 * The dispatch states that occupy *platform* capacity.
 *
 * Not the same set, and the difference is load-bearing: a `pending` job has no
 * instance behind it, so counting it as in flight would leave any run of more
 * than twenty-five jobs refusing its own first dispatch forever.
 */
export const LIVE_DISPATCH_STATES = dispatch.LIVE_COVER_DISPATCH_STATES;

export type CoverDispatchState = typeof COVER_DISPATCH_STATES[number];
export type CoverBackfillJobStatus = typeof COVER_BACKFILL_JOB_STATUSES[number];
export type CoverFenceState = typeof COVER_FENCE_STATES[number];
export type CoverBackfillRunStatus = typeof COVER_BACKFILL_RUN_STATUSES[number];
export type CoverBackfillRunMode = typeof COVER_BACKFILL_RUN_MODES[number];

/**
 * The launcher's five planning phases. Only three of them are run *modes* —
 * `event_cover_backfill_runs.mode` is constrained by `0012` to
 * `inventory | execute | verify`, and phase 2 adds no migration, so `dispatch`
 * and `confirm` are planner phases over an existing run and never appear in D1.
 */
export type CoverBackfillMode = 'inventory' | 'execute' | 'dispatch' | 'confirm' | 'verify';

export interface InventoryRow {
  id: string;
  cover_object_key: string;
  cover_revision: number;
}

export interface PlannedJob {
  jobId: string;
  eventId: string;
  expectedRevision: number;
  legacyKeyFingerprint: string;
  workflowInstanceId: string;
}

/** A run as D1 currently holds it. Resuming without one is refused. */
export interface RunStateRow {
  runId: string;
  mode: CoverBackfillRunMode;
  status: CoverBackfillRunStatus;
  cursor: string | null;
  inventorySha256: string | null;
}

/** A committed job row, selected back with its fence. The only dispatchable thing. */
export interface DurableDispatchRow {
  runId: string;
  jobId: string;
  eventId: string;
  workflowInstanceId: string;
  dispatchState: CoverDispatchState;
  dispatchGeneration: number;
  status: CoverBackfillJobStatus;
  fenceState: CoverFenceState | null;
  fenceGeneration: number | null;
}

export interface BackfillRunPlan {
  runId: string;
  cursor: string | null;
  inventorySha256: string | null;
  /** True when a resumed page came back empty: the durable end-of-inventory marker. */
  inventoryExhausted: boolean;
  jobs: PlannedJob[];
  /** Read-only when the plan is a dry run; the caller decides whether to apply. */
  statements: string[];
}

export interface DispatchWithheld {
  fence: number;
  activeRun: number;
  inFlight: number;
  minute: number;
  batch: number;
}

export type DispatchBound = 'none' | 'active-run' | 'in-flight' | 'minute' | 'batch';

export interface DispatchBatch {
  create: DurableDispatchRow[];
  /**
   * The transactional first part of each unit, in apply order: open the fence at
   * the job's current generation, move the job `pending → creating` at the next
   * one, and carry that same generation and timestamp onto the fence.
   */
  claimStatements: string[];
  /** POSIX-quoted `wrangler workflows trigger` invocations. */
  commands: string[];
  /** The same invocations quoted for PowerShell, which this repository uses. */
  powershellCommands: string[];
  fenceStatements: string[];
  withheld: DispatchWithheld;
  limitingBound: DispatchBound;
  blockedByActiveRun: boolean;
  /** The earliest instant this batch may be triggered: one minute after the last claim. */
  notBefore: string;
}

export interface DispatchObservation {
  rows: DurableDispatchRow[];
  nonterminal: number;
  activeRuns: number;
  minuteClaims: number;
  /** Retryable failures are reported, never dispatched: restart is Worker-side. */
  retryable: number;
  latestClaimAt: string | null;
}

export type ConfirmationOutcome = 'confirm' | 'blocked' | 'stale' | 'unusable';

export interface ConfirmationPlan {
  outcome: ConfirmationOutcome;
  reasons: string[];
  statements: string[];
  commands: string[];
  powershellCommands: string[];
}

export interface ConfirmationExpectation {
  runId: string;
  jobId: string;
  eventId: string;
  generation: number;
  now: string;
}

/* ------------------------------------------------------------------ *
 * Read-only SQL
 * ------------------------------------------------------------------ */

function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function assertUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`The ${label} must be a UUID.`);
  return value;
}

function assertGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('The dispatch generation must be a non-negative integer.');
  }
  return value;
}

/**
 * The one inventory predicate, and deliberately the indexable one.
 *
 * `cover_object_key IS NOT NULL AND cover_render_set_id IS NULL` is what a
 * legacy row *is*; probing `cover_config` for it would be a JSON scan of every
 * event and would also be wrong, because a `preset` row has a null key and a
 * null set and must never be swept up.
 */
export function inventorySql(cursor: string | null): string {
  if (cursor !== null && !UUID_PATTERN.test(cursor)) {
    throw new Error('The inventory cursor must be an event ID.');
  }
  return 'SELECT id, cover_object_key, cover_revision FROM events'
    + ' WHERE cover_object_key IS NOT NULL AND cover_render_set_id IS NULL'
    + ' AND deleted_at IS NULL'
    + (cursor === null ? '' : ` AND id > ${sqlString(cursor)}`)
    + ` ORDER BY id LIMIT ${constants.MAX_COVER_BACKFILL_PAGE_SIZE};`;
}

/** The four independent counts the zero-legacy proof is made of. */
export function proofSql(): string {
  return [
    "SELECT 'legacyRows' AS name, count(*) AS value FROM events",
    ' WHERE cover_object_key IS NOT NULL AND cover_render_set_id IS NULL AND deleted_at IS NULL',
    " UNION ALL SELECT 'blockingJobs', count(*) FROM event_cover_backfill_jobs j",
    ' JOIN events e ON e.id = j.event_id',
    " WHERE j.status IN ('needs_replacement', 'failed') AND e.deleted_at IS NULL",
    ' AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL',
    " UNION ALL SELECT 'incompleteActiveSets', count(*) FROM event_cover_render_sets s",
    " WHERE s.state = 'active' AND s.required_slots <> (",
    '   SELECT count(*) FROM event_cover_render_objects o WHERE o.render_set_id = s.id)',
    " UNION ALL SELECT 'uploadsWithoutActiveSet', count(*) FROM events e",
    " WHERE e.deleted_at IS NULL AND json_extract(e.cover_config, '$.source.kind') = 'upload'",
    ' AND NOT EXISTS (SELECT 1 FROM event_cover_render_sets s',
    "   WHERE s.id = e.cover_render_set_id AND s.event_id = e.id AND s.state = 'active');",
  ].join('');
}

/** The job-status counts a run reports, kept for operator display. */
export function inFlightSql(runId: string): string {
  assertUuid(runId, 'run ID');
  return 'SELECT status, count(*) AS value FROM event_cover_backfill_jobs'
    + ` WHERE run_id = ${sqlString(runId)} GROUP BY status;`;
}

/** The durable run state a resumed `execute` pass is required to carry. */
export function runStateSql(runId: string): string {
  assertUuid(runId, 'run ID');
  return "SELECT 'run' AS kind, id AS run_id, mode, status, cursor, inventory_sha256"
    + ` FROM event_cover_backfill_runs WHERE id = ${sqlString(runId)};`;
}

/**
 * Everything `dispatch` is allowed to know, read back from D1 in one command.
 *
 * The first statement offers only committed, pending, unclaimed jobs whose
 * event is neither deleted nor already owned by a purge. The second charges the
 * three bounds — in-flight, other active runs, and the rolling creation minute
 * — plus the retryable count, which is reported so an operator can see it and
 * never dispatched, because restart is a Worker-side transition.
 *
 * The rolling minute is measured against the database's own clock rather than
 * the launcher's, so a skewed operator workstation cannot widen the budget.
 */
export function dispatchSql(runId: string): string {
  assertUuid(runId, 'run ID');
  const run = sqlString(runId);
  const binding = sqlString(COVER_BACKFILL_BINDING);
  // A fence that has been claimed at least once, for any event: the creation
  // budget is a property of the deployment, not of one run.
  const claimedFence = `f.workflow_binding = ${binding}`
    + " AND f.state = 'open' AND f.dispatch_generation > 0";
  return [
    "SELECT 'dispatchable' AS kind, j.run_id AS run_id, j.id AS job_id,",
    ' j.event_id AS event_id, j.workflow_instance_id AS workflow_instance_id,',
    ' j.dispatch_state AS dispatch_state, j.dispatch_generation AS dispatch_generation,',
    ' j.status AS status, f.state AS fence_state, f.dispatch_generation AS fence_generation',
    ' FROM event_cover_backfill_jobs j',
    ' JOIN events e ON e.id = j.event_id',
    ' LEFT JOIN event_cover_workflow_fences f',
    `   ON f.workflow_binding = ${binding}`,
    '  AND f.workflow_instance_id = j.workflow_instance_id AND f.event_id = j.event_id',
    ` WHERE j.run_id = ${run} AND j.dispatch_state = 'pending' AND j.status = 'queued'`,
    ' AND e.deleted_at IS NULL',
    ' AND NOT EXISTS (SELECT 1 FROM event_cover_purge_progress p WHERE p.event_id = j.event_id)',
    ` ORDER BY j.created_at, j.id LIMIT ${constants.MAX_COVER_BACKFILL_CREATE_BATCH};`,
    // In flight, not merely nonterminal: a `pending` job is queued in the ledger
    // and has no instance behind it. Counting those would make a run of more
    // than one batch refuse its own first dispatch and never recover.
    "SELECT 'nonterminal' AS kind, count(*) AS value, NULL AS at",
    ' FROM event_cover_backfill_jobs',
    ` WHERE run_id = ${run}`,
    ` AND dispatch_state IN (${LIVE_DISPATCH_STATES.map(sqlString).join(', ')})`,
    ` AND status IN (${NONTERMINAL_JOB_STATUSES.map(sqlString).join(', ')})`,
    " UNION ALL SELECT 'activeRuns', count(*), NULL FROM event_cover_backfill_runs",
    ` WHERE id <> ${run} AND status IN ('inventorying', 'executing')`,
    " UNION ALL SELECT 'minuteClaims', count(*), NULL FROM event_cover_workflow_fences f",
    ` WHERE ${claimedFence}`,
    "   AND f.updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')",
    " UNION ALL SELECT 'retryable', count(*), NULL FROM event_cover_backfill_jobs",
    ` WHERE run_id = ${run} AND status = 'failed' AND retryable = 1`,
    " UNION ALL SELECT 'latestClaimAt', 0, max(f.updated_at) FROM event_cover_workflow_fences f",
    ` WHERE ${claimedFence};`,
  ].join('');
}

/**
 * The same predicate inputs the Worker binds, rendered as reviewable literals.
 *
 * A generated artifact has to be readable as text before an operator applies it,
 * which is the one reason the two sides render differently at all. Everything
 * between the values is the shared builder's.
 */
function dispatchSqlValues(input: {
  runId: string; jobId: string; eventId: string; generation: number; now: string;
}): CoverDispatchModule.CoverDispatchSqlValues {
  return {
    binding: sqlString(COVER_BACKFILL_BINDING),
    runId: sqlString(assertUuid(input.runId, 'run ID')),
    jobId: sqlString(assertUuid(input.jobId, 'job ID')),
    eventId: sqlString(assertUuid(input.eventId, 'event ID')),
    generation: String(assertGeneration(input.generation)),
    now: sqlString(input.now),
  };
}

/**
 * The post-trigger read for exactly one dispatch unit, job and fence together.
 *
 * Rendered from the shared builder the Worker also uses, so the operator's
 * confirmation and the Worker's backstop are answering from the same shape of
 * evidence rather than two hand-written approximations of it.
 */
export function confirmSql(input: { runId: string; jobId: string; eventId: string }): string {
  assertUuid(input.runId, 'run ID');
  assertUuid(input.jobId, 'job ID');
  assertUuid(input.eventId, 'event ID');
  return `${dispatch.coverDispatchReadSql({
    binding: sqlString(COVER_BACKFILL_BINDING),
    runId: sqlString(input.runId),
    jobId: sqlString(input.jobId),
    eventId: sqlString(input.eventId),
  })};`;
}

/* ------------------------------------------------------------------ *
 * Remote command surface
 * ------------------------------------------------------------------ */

function posixQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function powershellQuote(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

/**
 * Wrangler 4.113, read off `--help` rather than assumed.
 *
 * `d1 execute` has `--remote`. `workflows trigger` and
 * `workflows instances terminate` do **not**: they take `--local` or nothing,
 * and passing `--remote` is an unknown-argument error. So "always pass
 * --remote" is not a rule that applies uniformly, and the Workflow commands are
 * instead pinned by carrying `--config` and never carrying `--local`.
 */
export function d1ReadCommands(sql: string): { posix: string; powershell: string } {
  const prefix = `npx wrangler d1 execute ${COVER_BACKFILL_DATABASE_NAME}`
    + ` --remote --config ${WRANGLER_CONFIG_PATH} --json --command `;
  return { posix: `${prefix}${posixQuote(sql)}`, powershell: `${prefix}${powershellQuote(sql)}` };
}

/** Mutating SQL travels as a file, so no shell ever has to quote it correctly. */
export function d1FileCommand(sqlFile: string): string {
  return `npx wrangler d1 execute ${COVER_BACKFILL_DATABASE_NAME}`
    + ` --remote --config ${WRANGLER_CONFIG_PATH} --json --file ${sqlFile}`;
}

/** Run these first. An artifact whose recorded identity does not match is void. */
export function identityCheckCommands(): string[] {
  return [
    'npx wrangler whoami --json',
    `npx wrangler d1 info ${COVER_BACKFILL_DATABASE_NAME} --config ${WRANGLER_CONFIG_PATH} --json`,
  ];
}

export function terminateCommand(instanceId: string): string {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error('The workflow instance ID is not a cover backfill instance.');
  }
  return `npx wrangler workflows instances terminate ${COVER_BACKFILL_WORKFLOW_NAME}`
    + ` ${instanceId} --config ${WRANGLER_CONFIG_PATH}`;
}

/* ------------------------------------------------------------------ *
 * Payload parsing
 * ------------------------------------------------------------------ */

/**
 * `wrangler d1 execute --json` answers with one envelope per statement. A bare
 * array of rows is accepted too, so a hand-saved payload does not have to be
 * reshaped.
 */
function resultSets(payload: unknown): unknown[][] {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return [[]];
    const enveloped = payload.every(
      (entry) => entry !== null && typeof entry === 'object' && 'results' in entry,
    );
    if (!enveloped) return [payload];
    return payload.map((entry) => {
      const results = (entry as { results: unknown }).results;
      if (!Array.isArray(results)) throw new Error('The payload envelope has no results array.');
      return results;
    });
  }
  if (payload && typeof payload === 'object' && 'results' in payload) {
    const results = (payload as { results: unknown }).results;
    if (Array.isArray(results)) return [results];
  }
  throw new Error('The payload is not a wrangler d1 execute --json result.');
}

function firstResultArray(payload: unknown): unknown[] {
  return resultSets(payload)[0]!;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function requireUuid(row: Record<string, unknown>, key: string, context: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${context} has no ${key}.`);
  }
  return value;
}

function requireCount(row: Record<string, unknown>, key: string, context: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${context} has no ${key}.`);
  }
  return value;
}

function requireMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`A row carries an unknown ${label}.`);
  }
  return value as T;
}

export function parseInventoryPayload(payload: unknown): InventoryRow[] {
  const rows = firstResultArray(payload);
  if (rows.length > constants.MAX_COVER_BACKFILL_PAGE_SIZE) {
    throw new Error(
      `The inventory payload has ${rows.length} rows, above the ${constants.MAX_COVER_BACKFILL_PAGE_SIZE}-row page size.`,
    );
  }
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`Inventory row ${index} is not an object.`);
    const entry = row as Record<string, unknown>;
    const id = entry['id'];
    const key = entry['cover_object_key'];
    const revision = entry['cover_revision'];
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw new Error(`Inventory row ${index} has no event ID.`);
    }
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`Inventory row ${index} has no legacy cover key.`);
    }
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
      throw new Error(`Inventory row ${index} has no cover revision.`);
    }
    return { id, cover_object_key: key, cover_revision: revision };
  });
}

export function parseCountPayload(payload: unknown): Record<string, number> {
  const rows = firstResultArray(payload);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const entry = row as Record<string, unknown>;
    const name = entry['name'] ?? entry['status'];
    const value = entry['value'];
    if (typeof name !== 'string' || typeof value !== 'number') {
      throw new Error('A count payload row has no name/value pair.');
    }
    counts[name] = value;
  }
  return counts;
}

export function parseRunStatePayload(payload: unknown): RunStateRow {
  const rows = resultSets(payload).flat();
  if (rows.length !== 1) {
    throw new Error(`The run state payload has ${rows.length} rows; it must have exactly one.`);
  }
  const entry = record(rows[0], 'The run state row');
  return {
    runId: requireUuid(entry, 'run_id', 'The run state row'),
    mode: requireMember(entry['mode'], COVER_BACKFILL_RUN_MODES, 'run mode'),
    status: requireMember(entry['status'], COVER_BACKFILL_RUN_STATUSES, 'run status'),
    cursor: entry['cursor'] === null || entry['cursor'] === undefined
      ? null
      : requireUuid(entry, 'cursor', 'The run state row'),
    inventorySha256: entry['inventory_sha256'] === null || entry['inventory_sha256'] === undefined
      ? null
      : assertDigest(String(entry['inventory_sha256'])),
  };
}

function parseJobFenceRow(value: unknown, kind: string): DurableDispatchRow {
  const entry = record(value, `A ${kind} row`);
  const context = `A ${kind} row`;
  const instanceId = entry['workflow_instance_id'];
  if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error(`${context} has no cover backfill workflow instance ID.`);
  }
  const fenceState = entry['fence_state'];
  const fenceGeneration = entry['fence_generation'];
  return {
    runId: requireUuid(entry, 'run_id', context),
    jobId: requireUuid(entry, 'job_id', context),
    eventId: requireUuid(entry, 'event_id', context),
    workflowInstanceId: instanceId,
    dispatchState: requireMember(entry['dispatch_state'], COVER_DISPATCH_STATES, 'dispatch state'),
    dispatchGeneration: requireCount(entry, 'dispatch_generation', context),
    status: requireMember(entry['status'], COVER_BACKFILL_JOB_STATUSES, 'job status'),
    fenceState: fenceState === null || fenceState === undefined
      ? null
      : requireMember(fenceState, COVER_FENCE_STATES, 'fence state'),
    fenceGeneration: fenceGeneration === null || fenceGeneration === undefined
      ? null
      : requireCount(entry, 'fence_generation', context),
  };
}

/**
 * Everything `dispatch` may act on, and nothing it may assume.
 *
 * A counter absent from the payload is an error rather than a zero: a lost
 * statement would otherwise read as "no jobs in flight" and authorize a batch
 * on no evidence, which is the exact defect the hard-coded `nonterminal: 0`
 * used to be.
 */
export function parseDispatchPayload(payload: unknown): DispatchObservation {
  const rows: DurableDispatchRow[] = [];
  const counters = new Map<string, number>();
  let latestClaimAt: string | null = null;
  let sawLatestClaim = false;

  for (const set of resultSets(payload)) {
    for (const value of set) {
      const entry = record(value, 'A dispatch payload row');
      const kind = entry['kind'];
      if (kind === 'dispatchable') {
        rows.push(parseJobFenceRow(entry, 'dispatchable'));
        continue;
      }
      if (kind === 'latestClaimAt') {
        sawLatestClaim = true;
        const at = entry['at'];
        if (at !== null && at !== undefined) {
          if (typeof at !== 'string' || !ISO_INSTANT_PATTERN.test(at)) {
            throw new Error('The latest fence claim is not a UTC instant.');
          }
          latestClaimAt = at;
        }
        continue;
      }
      if (kind === 'nonterminal' || kind === 'activeRuns' || kind === 'minuteClaims'
        || kind === 'retryable') {
        counters.set(kind, requireCount(entry, 'value', `The ${kind} counter`));
        continue;
      }
      throw new Error(`The dispatch payload carries an unknown row kind ${JSON.stringify(kind)}.`);
    }
  }

  for (const name of ['nonterminal', 'activeRuns', 'minuteClaims', 'retryable']) {
    if (!counters.has(name)) {
      throw new Error(`The dispatch payload is missing its ${name} counter.`);
    }
  }
  if (!sawLatestClaim) {
    throw new Error('The dispatch payload is missing its latestClaimAt row.');
  }

  return {
    rows,
    nonterminal: counters.get('nonterminal')!,
    activeRuns: counters.get('activeRuns')!,
    minuteClaims: counters.get('minuteClaims')!,
    retryable: counters.get('retryable')!,
    latestClaimAt,
  };
}

/** Zero, one, or several rows — `evaluateConfirmation` decides what that means. */
export function parseConfirmPayload(payload: unknown): DurableDispatchRow[] {
  const rows: DurableDispatchRow[] = [];
  for (const set of resultSets(payload)) {
    for (const value of set) {
      const entry = record(value, 'A confirmation row');
      if (entry['kind'] !== 'confirm') {
        throw new Error('The confirmation payload carries a row that is not a confirmation read.');
      }
      rows.push(parseJobFenceRow(entry, 'confirmation'));
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

function hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function assertDigest(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error('An inventory digest must be a SHA-256 hex digest.');
  return value;
}

/** The same lowercase SHA-256 of the object key `coverKeyFingerprint` produces. */
export function fingerprintKey(objectKey: string): string {
  return hex(objectKey);
}

/**
 * The same derivation the Worker's `coverBackfillInstanceId` performs.
 *
 * A later inventory run allocates a new job ID and therefore a new instance ID
 * rather than attempting to reuse one the platform may still be retaining.
 */
export function backfillInstanceId(runId: string, jobId: string, eventId: string): string {
  return `cb1-${hex(`cover-backfill-v1|${runId}|${jobId}|${eventId}`).slice(0, 48)}`;
}

/**
 * A digest of exactly what one page inventoried, in inventory order.
 *
 * Over the event ID and its key fingerprint rather than the key itself, so the
 * digest can be recorded and compared without a server-only key ever entering an
 * artifact an operator might paste somewhere.
 */
export function inventoryDigest(rows: readonly InventoryRow[]): string {
  return hex(rows.map((row) => `${row.id}:${fingerprintKey(row.cover_object_key)}`).join('\n'));
}

/**
 * A per-page digest cannot describe a multi-page walk, so each page is chained
 * into the one before it. The stored value is a commitment to the whole ordered
 * inventory, and re-applying a page changes it — which is what lets the ledger
 * update guard on the digest it expects to be replacing.
 */
export function rollingInventoryDigest(
  previous: string | null,
  rows: readonly InventoryRow[],
): string {
  const page = inventoryDigest(rows);
  if (previous === null) return page;
  return hex(`${assertDigest(previous)}\n${page}`);
}

/* ------------------------------------------------------------------ *
 * Plans
 * ------------------------------------------------------------------ */

export function buildBackfillRunPlan(input: {
  runId: string;
  rows: readonly InventoryRow[];
  now: string;
  runState: RunStateRow | null;
  makeJobId?: () => string;
}): BackfillRunPlan {
  assertUuid(input.runId, 'run ID');
  if (!ISO_INSTANT_PATTERN.test(input.now)) throw new Error('The timestamp must be a UTC instant.');
  if (input.rows.length > constants.MAX_COVER_BACKFILL_PAGE_SIZE) {
    throw new Error('An inventory page may not exceed the page size.');
  }

  const state = input.runState;
  if (state) {
    if (state.runId !== input.runId) {
      throw new Error('The run state describes a different run than the one being resumed.');
    }
    if (state.status !== 'inventorying') {
      throw new Error(`The run state says this run is already ${state.status}; it cannot inventory.`);
    }
    if (state.mode !== 'inventory') {
      throw new Error(`The run state says this run is in ${state.mode} mode; it cannot inventory.`);
    }
  }

  const now = sqlString(input.now);
  const run = sqlString(input.runId);
  const statements: string[] = [];

  // A resumed page that comes back empty is the durable end-of-inventory
  // marker, and the only one. It must not rewrite the cursor: doing that is
  // what made the next pass restart from the first event and re-propose a job
  // for every row already committed.
  if (state && input.rows.length === 0) {
    statements.push(
      'UPDATE event_cover_backfill_runs'
      + ` SET mode = 'execute', status = 'executing', updated_at = ${now}`
      + ` WHERE id = ${run} AND status = 'inventorying' AND mode = 'inventory';`,
    );
    return {
      runId: input.runId,
      cursor: state.cursor,
      inventorySha256: state.inventorySha256,
      inventoryExhausted: true,
      jobs: [],
      statements,
    };
  }

  const makeJobId = input.makeJobId ?? randomUUID;
  const jobs: PlannedJob[] = input.rows.map((row) => {
    const jobId = makeJobId();
    return {
      jobId,
      eventId: row.id,
      expectedRevision: row.cover_revision,
      legacyKeyFingerprint: fingerprintKey(row.cover_object_key),
      workflowInstanceId: backfillInstanceId(input.runId, jobId, row.id),
    };
  });

  const cursor = input.rows.length > 0 ? input.rows[input.rows.length - 1]!.id : null;
  const inventorySha256 = input.rows.length > 0
    ? rollingInventoryDigest(state?.inventorySha256 ?? null, input.rows)
    : state?.inventorySha256 ?? inventoryDigest(input.rows);
  const dependencies = JSON.stringify(COVER_BACKFILL_DEPENDENCY_VERSIONS);

  if (!state) {
    statements.push(
      'INSERT INTO event_cover_backfill_runs (id, mode, cursor, inventory_sha256, status, created_at, updated_at)'
      + ` VALUES (${run}, 'inventory', ${cursor === null ? 'NULL' : sqlString(cursor)},`
      + ` ${sqlString(inventorySha256)}, 'inventorying', ${now}, ${now});`,
    );
  } else {
    // Guarded on the exact cursor and digest being replaced, so re-applying the
    // same page a second time changes nothing rather than chaining it twice.
    const cursorGuard = state.cursor === null
      ? `(cursor IS NULL OR cursor < ${sqlString(cursor!)})`
      : `cursor < ${sqlString(cursor!)}`;
    const digestGuard = state.inventorySha256 === null
      ? 'inventory_sha256 IS NULL'
      : `inventory_sha256 = ${sqlString(state.inventorySha256)}`;
    statements.push(
      'UPDATE event_cover_backfill_runs'
      + ` SET cursor = ${sqlString(cursor!)}, inventory_sha256 = ${sqlString(inventorySha256)},`
      + ` updated_at = ${now}`
      + ` WHERE id = ${run} AND status = 'inventorying' AND mode = 'inventory'`
      + ` AND ${cursorGuard} AND ${digestGuard};`,
    );
  }

  for (const job of jobs) {
    statements.push(
      'INSERT INTO event_cover_backfill_jobs ('
      + 'id, run_id, event_id, expected_revision, legacy_key_fingerprint, workflow_instance_id,'
      + ' dispatch_state, dispatch_generation, status, dependency_versions_json, created_at, updated_at)'
      + ` SELECT ${sqlString(job.jobId)}, ${run}, ${sqlString(job.eventId)},`
      + ` ${job.expectedRevision}, ${sqlString(job.legacyKeyFingerprint)},`
      + ` ${sqlString(job.workflowInstanceId)}, 'pending', 0, 'queued', ${sqlString(dependencies)},`
      + ` ${now}, ${now}`
      // Re-inventorying an event that has since been converted, or that already
      // has a live job in this run, must not allocate a second one.
      + ' WHERE EXISTS (SELECT 1 FROM events WHERE id = ' + sqlString(job.eventId)
      + ' AND deleted_at IS NULL AND cover_object_key IS NOT NULL AND cover_render_set_id IS NULL'
      + ` AND cover_revision = ${job.expectedRevision})`
      + ' AND NOT EXISTS (SELECT 1 FROM event_cover_backfill_jobs'
      + ` WHERE run_id = ${run} AND event_id = ${sqlString(job.eventId)});`,
    );
  }

  return { runId: input.runId, cursor, inventorySha256, inventoryExhausted: false, jobs, statements };
}

/**
 * One bounded dispatch batch, built only from rows D1 returned.
 *
 * Four bounds compose into one capacity and the tightest wins: never beside
 * another active run, never above the in-flight ceiling, never more than one
 * batch, and never more than one minute's creates. A run at any ceiling creates
 * nothing at all rather than creating one more.
 *
 * A fence the purge coordinator owns, or one standing at a generation this job
 * is not claiming, excludes its row outright — the first because a blocked
 * fence is the one thing that must never be triggered, the second because an
 * unexplained generation is ambiguous rather than safe.
 */
export function buildDispatchBatch(input: {
  runId: string;
  rows: readonly DurableDispatchRow[];
  nonterminal: number;
  activeRuns: number;
  minuteClaims: number;
  latestClaimAt: string | null;
  now: string;
}): DispatchBatch {
  assertUuid(input.runId, 'run ID');
  if (!ISO_INSTANT_PATTERN.test(input.now)) throw new Error('The timestamp must be a UTC instant.');
  for (const [label, value] of [
    ['nonterminal', input.nonterminal],
    ['active-run', input.activeRuns],
    ['rolling minute', input.minuteClaims],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`The ${label} count cannot be negative.`);
    }
  }
  for (const row of input.rows) {
    if (row.runId !== input.runId) {
      throw new Error('A dispatch row belongs to a different run than the one being dispatched.');
    }
  }

  const eligible = input.rows.filter((row) => (
    row.fenceState === null
    || (row.fenceState === 'open' && row.fenceGeneration === row.dispatchGeneration)
  ));
  const withheld: DispatchWithheld = {
    fence: input.rows.length - eligible.length,
    activeRun: 0,
    inFlight: 0,
    minute: 0,
    batch: 0,
  };

  const claimedAt = input.latestClaimAt === null ? null : Date.parse(input.latestClaimAt);
  const notBefore = claimedAt === null || Number.isNaN(claimedAt)
    ? input.now
    : new Date(Math.max(Date.parse(input.now), claimedAt + ROLLING_MINUTE_MS)).toISOString();

  const empty = (bound: DispatchBound, bucket: keyof DispatchWithheld): DispatchBatch => {
    withheld[bucket] = eligible.length;
    return {
      create: [],
      claimStatements: [],
      commands: [],
      powershellCommands: [],
      fenceStatements: [],
      withheld,
      limitingBound: eligible.length > 0 ? bound : 'none',
      blockedByActiveRun: bound === 'active-run',
      notBefore,
    };
  };

  if (input.activeRuns > 0) return empty('active-run', 'activeRun');

  const bounds = [
    ['batch', constants.MAX_COVER_BACKFILL_CREATE_BATCH, 'batch'],
    ['minute', constants.MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE - input.minuteClaims, 'minute'],
    ['in-flight', constants.MAX_COVER_BACKFILL_IN_FLIGHT - input.nonterminal, 'inFlight'],
  ] as const;
  const capacity = Math.max(0, Math.min(...bounds.map(([, value]) => value)));
  // Tie-break widest-to-narrowest so a shared ceiling is attributed to the
  // batch rule rather than to a headroom that happens to equal it.
  const limiter = bounds.find(([, value]) => value === capacity)!;

  const create = eligible.slice(0, capacity);
  withheld[limiter[2]] = eligible.length - create.length;

  const expiresAt = new Date(Date.parse(input.now) + FENCE_TTL_MS).toISOString();
  const fenceStatements = create.map((row) => (
    'INSERT INTO event_cover_workflow_fences ('
    + 'workflow_binding, workflow_instance_id, event_id, dispatch_generation, state,'
    + ' created_at, updated_at, expires_at)'
    + ` SELECT ${sqlString(COVER_BACKFILL_BINDING)}, ${sqlString(row.workflowInstanceId)},`
    + ` ${sqlString(row.eventId)}, ${row.dispatchGeneration}, 'open', ${sqlString(input.now)},`
    + ` ${sqlString(input.now)}, ${sqlString(expiresAt)}`
    // Guarded the way the job inserts are, and for a sharper reason. A fence
    // carries no foreign key to `events` — it has to outlive the row it
    // protected — so nothing in the schema stops an operator from applying a
    // stale dispatch artifact to an event whose purge has already left the
    // `fences` phase. That fence would be opened behind the coordinator's back,
    // parked at the hold sentinel by the next pass, and never settled, because
    // the `r2` and `relational` phases do not run the fence walk again.
    + ' WHERE EXISTS (SELECT 1 FROM events WHERE id = ' + sqlString(row.eventId)
    + ' AND deleted_at IS NULL)'
    + ' AND NOT EXISTS (SELECT 1 FROM event_cover_purge_progress p WHERE p.event_id = '
    + `${sqlString(row.eventId)})`
    // A fence the purge coordinator already holds keeps its hold; this never
    // reopens one.
    + ' ON CONFLICT (workflow_binding, workflow_instance_id) DO NOTHING;'
  ));

  // The unit's first part, and the reason the bounds are not merely a property
  // of the read that produced this artifact. A generated claim can sit in a
  // terminal for minutes; every refusal is re-evaluated by the database at apply
  // time, so a batch that has gone stale simply changes nothing.
  const claimStatements = create.flatMap((row, index) => {
    const claim = dispatch.claimCoverBackfillDispatchSql(
      {
        ...dispatchSqlValues({
          runId: input.runId,
          jobId: row.jobId,
          eventId: row.eventId,
          generation: row.dispatchGeneration,
          now: input.now,
        }),
        workflowInstanceId: sqlString(row.workflowInstanceId),
      },
      {
        inFlight: constants.MAX_COVER_BACKFILL_IN_FLIGHT,
        perMinute: constants.MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
      },
    );
    return [fenceStatements[index]!, `${claim.job};`, `${claim.fence};`];
  });

  // Read off `wrangler workflows --help` at 4.113.0 rather than assumed: there is
  // no `workflows instances create`. The instance subcommands are list, describe,
  // send-event, terminate, restart, pause, and resume; creation is `trigger`,
  // whose params are a positional JSON string and whose `--id` is the only way to
  // give an instance the deterministic ID the fence is keyed by. `--remote` does
  // not exist here; `--config` plus the absence of `--local` is what targets the
  // deployed Workflow.
  const paramsFor = (row: DurableDispatchRow) => JSON.stringify({
    runId: input.runId,
    jobId: row.jobId,
    eventId: row.eventId,
  });
  const commands = create.map((row) => (
    `npx wrangler workflows trigger ${COVER_BACKFILL_WORKFLOW_NAME} '${paramsFor(row)}'`
    + ` --id ${row.workflowInstanceId} --config ${WRANGLER_CONFIG_PATH}`
  ));
  // A single-quoted JSON payload survives POSIX and is eaten by PowerShell, so
  // the operator gets the doubled-quote form rather than an instance created
  // with no parameters at all.
  const powershellCommands = create.map((row) => (
    `npx wrangler workflows trigger ${COVER_BACKFILL_WORKFLOW_NAME}`
    + ` "${paramsFor(row).replace(/"/gu, '""')}"`
    + ` --id ${row.workflowInstanceId} --config ${WRANGLER_CONFIG_PATH}`
  ));

  return {
    create,
    claimStatements,
    commands,
    powershellCommands,
    fenceStatements,
    withheld,
    limitingBound: create.length === eligible.length ? 'none' : limiter[0],
    blockedByActiveRun: false,
    notBefore,
  };
}

/**
 * What the post-trigger read permits, and nothing more.
 *
 * Only an open fence at the claimed generation authorizes a confirmation, and
 * even then the emitted statement rechecks the fence and the event so a
 * deletion landing between the read and the apply records no success. A blocked
 * fence emits the terminate and failure unit instead. Everything else — a moved
 * generation, a swept fence, a terminal job, no row, or more than one — emits no
 * mutation at all.
 */
export function evaluateConfirmation(
  rows: readonly DurableDispatchRow[],
  expected: ConfirmationExpectation,
): ConfirmationPlan {
  assertUuid(expected.runId, 'run ID');
  assertUuid(expected.jobId, 'job ID');
  assertUuid(expected.eventId, 'event ID');
  assertGeneration(expected.generation);
  if (!ISO_INSTANT_PATTERN.test(expected.now)) {
    throw new Error('The timestamp must be a UTC instant.');
  }

  const nothing = (outcome: ConfirmationOutcome, reason: string): ConfirmationPlan => ({
    outcome, reasons: [reason], statements: [], commands: [], powershellCommands: [],
  });

  if (rows.length === 0) return nothing('unusable', 'The read returned no job row.');
  if (rows.length > 1) {
    return nothing('unusable', `The read returned ${rows.length} rows for one job.`);
  }
  const row = rows[0]!;
  if (row.runId !== expected.runId || row.jobId !== expected.jobId
    || row.eventId !== expected.eventId) {
    return nothing('unusable', 'The read describes a different job than the one claimed.');
  }
  if (row.dispatchGeneration !== expected.generation) {
    return nothing(
      'stale',
      `The job stands at generation ${row.dispatchGeneration}, not ${expected.generation}.`,
    );
  }

  const values = dispatchSqlValues(expected);

  if (row.fenceState === null) {
    return nothing('stale', 'The fence for this instance no longer exists.');
  }

  if (row.fenceState === 'deletion-blocked') {
    return {
      outcome: 'blocked',
      reasons: ['An event purge owns this fence; the dispatch unit settles as EVENT_DELETED.'],
      statements: [`${dispatch.blockCoverBackfillDispatchSql(values)};`],
      commands: [terminateCommand(row.workflowInstanceId)],
      powershellCommands: [terminateCommand(row.workflowInstanceId)],
    };
  }

  if (row.fenceGeneration !== expected.generation) {
    return nothing(
      'stale',
      `The fence stands at generation ${row.fenceGeneration}, not ${expected.generation}.`,
    );
  }
  if (row.dispatchState !== 'creating' && row.dispatchState !== 'confirmed') {
    return nothing('stale', `The job is ${row.dispatchState}; there is nothing to confirm.`);
  }

  const reasons = row.dispatchState === 'confirmed'
    ? ['This generation is already confirmed; the guarded statement is a replay and changes nothing.']
    : ['The fence is open at the claimed generation.'];

  return {
    outcome: 'confirm',
    reasons,
    statements: [`${dispatch.confirmCoverBackfillDispatchSql(values)};`],
    commands: [],
    powershellCommands: [],
  };
}

/**
 * Opening a verification run is the launcher's whole authority over the proof.
 *
 * Recording one as `verified` is a Worker-side transition that re-derives all
 * four predicates at commit time, so no statement here may set that status.
 */
export function verificationRunStatement(input: { runId: string; now: string }): string {
  assertUuid(input.runId, 'run ID');
  if (!ISO_INSTANT_PATTERN.test(input.now)) throw new Error('The timestamp must be a UTC instant.');
  const now = sqlString(input.now);
  return 'INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)'
    + ` VALUES (${sqlString(input.runId)}, 'verify', 'executing', ${now}, ${now});`;
}

export interface ZeroLegacyEvaluation {
  counts: Record<string, number>;
  issues: string[];
  proven: boolean;
}

/**
 * The proof, evaluated rather than asserted.
 *
 * A missing count is an issue, not a pass: a payload that lost a statement would
 * otherwise read as four zeroes and authorize phase 3 on no evidence at all.
 */
export function evaluateZeroLegacyProof(payload: unknown): ZeroLegacyEvaluation {
  const counts = parseCountPayload(payload);
  const required = [
    'legacyRows',
    'blockingJobs',
    'incompleteActiveSets',
    'uploadsWithoutActiveSet',
  ] as const;
  const issues: string[] = [];
  for (const name of required) {
    const value = counts[name];
    if (value === undefined) issues.push(`${name} is missing from the proof payload.`);
    else if (value !== 0) issues.push(`${name} is ${value}.`);
  }
  return { counts, issues, proven: issues.length === 0 };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export interface CoverBackfillRequest {
  mode: CoverBackfillMode;
  payloadFile: string | null;
  planFile: string | null;
  runStateFile: string | null;
  runId: string | null;
  jobId: string | null;
  eventId: string | null;
  generation: number | null;
  accountId: string | null;
  cursor: string | null;
  now: string;
  confirmed: boolean;
}

const MODES: readonly CoverBackfillMode[] = [
  'inventory', 'execute', 'dispatch', 'confirm', 'verify',
];
const VALUE_FLAGS = [
  '--payload-file', '--plan-file', '--run-state-file', '--run-id', '--job-id',
  '--event-id', '--generation', '--account-id', '--cursor', '--now',
] as const;

export function parseCoverBackfillArgs(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): CoverBackfillRequest {
  const [first, ...rest] = args;
  const mode: CoverBackfillMode = first === undefined
    ? 'inventory'
    : MODES.includes(first as CoverBackfillMode)
      ? first as CoverBackfillMode
      : (() => {
        throw new Error(`Unknown mode ${first}. Use ${MODES.join(', ')}.`);
      })();

  const request: CoverBackfillRequest = {
    mode,
    payloadFile: null,
    planFile: null,
    runStateFile: null,
    runId: null,
    jobId: null,
    eventId: null,
    generation: null,
    accountId: null,
    cursor: null,
    now: new Date().toISOString(),
    confirmed: Boolean(env['CANDIDARY_COVER_BACKFILL_CONFIRM']),
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === undefined || !(VALUE_FLAGS as readonly string[]).includes(flag)) {
      throw new Error(`Unknown argument ${String(flag)}.`);
    }
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    index += 1;
    if (flag === '--payload-file') request.payloadFile = value;
    if (flag === '--plan-file') request.planFile = value;
    if (flag === '--run-state-file') request.runStateFile = value;
    if (flag === '--run-id') request.runId = value;
    if (flag === '--job-id') request.jobId = value;
    if (flag === '--event-id') request.eventId = value;
    if (flag === '--account-id') request.accountId = value;
    if (flag === '--cursor') request.cursor = value;
    if (flag === '--now') request.now = value;
    if (flag === '--generation') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error('--generation must be a non-negative integer generation.');
      }
      request.generation = parsed;
    }
  }
  return request;
}

/**
 * A raw payload carries object keys and a written artifact carries the exact
 * commands to run, so neither may land anywhere a commit could pick it up. A
 * path outside the checkout is the operator's business; a path inside it has to
 * be under the ignored `output/` directory.
 */
function contains(parent: string, child: string): boolean {
  const step = relative(parent, child);
  // `relative` answers with an absolute path when the two are on different
  // Windows drives, which is another way of saying "not underneath".
  return step !== '' && !step.startsWith('..') && !isAbsolute(step);
}

function artifactPathProblem(path: string): string | null {
  const absolute = resolve(PROJECT_ROOT, path);
  if (!contains(PROJECT_ROOT, absolute)) return null;
  if (contains(ARTIFACT_ROOT, absolute)) return null;
  return `${path} is inside the repository but not under output/, which is the only ignored`
    + ' artifact directory. Cover backfill payloads and plans carry object keys and exact'
    + ' production commands; write them to output/ or outside the checkout.';
}

function readPayload(file: string): unknown {
  return JSON.parse(readFileSync(resolve(PROJECT_ROOT, file), 'utf8')) as unknown;
}

function writeArtifact(file: string, contents: string): void {
  const absolute = resolve(PROJECT_ROOT, file);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

function sqlPathFor(planFile: string): string {
  return planFile.replace(/\.json$/u, '') + '.sql';
}

function printRead(log: (message: string) => void, sql: string): void {
  const commands = d1ReadCommands(sql);
  log('Run this read-only statement against the remote database:');
  log(`  ${commands.posix}`);
  log('  (PowerShell)');
  log(`  ${commands.powershell}`);
  log('Then pass its saved JSON back with --payload-file. The statement is:');
  log(sql);
}

export function runCli(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  log: (message: string) => void = console.log,
): number {
  const request = parseCoverBackfillArgs(args, env);

  // Path safety is checked before anything is read, so a mistyped artifact
  // destination can never be discovered after a payload has been loaded.
  for (const candidate of [request.payloadFile, request.planFile, request.runStateFile]) {
    if (candidate === null) continue;
    const problem = artifactPathProblem(candidate);
    if (problem) {
      log(problem);
      return 1;
    }
  }

  const identity = {
    accountId: request.accountId,
    worker: COVER_BACKFILL_WORKER_NAME,
    database: { name: COVER_BACKFILL_DATABASE_NAME, id: COVER_BACKFILL_DATABASE_ID },
    workflow: COVER_BACKFILL_WORKFLOW_NAME,
    wranglerConfig: WRANGLER_CONFIG_PATH,
  };
  const requireAccount = (): boolean => {
    if (request.accountId) return true;
    log('--account-id is required before an artifact may record which account it targets.');
    return false;
  };

  if (request.mode === 'verify') {
    if (!request.payloadFile) {
      printRead(log, proofSql());
      return 0;
    }
    const evaluation = evaluateZeroLegacyProof(readPayload(request.payloadFile));
    log(JSON.stringify(evaluation, null, 2));
    if (!evaluation.proven) {
      log('The zero-legacy proof is red. Phase 3 is not authorized.');
      return 1;
    }
    log('The zero-legacy proof is green. Phase 3 remains a separately authorized release activity.');
    if (!request.confirmed) {
      log('Set CANDIDARY_COVER_BACKFILL_CONFIRM with --run-id to open a verification run.');
      return 0;
    }
    if (!request.runId) {
      log('--run-id is required to open a verification run.');
      return 1;
    }
    log('Verification run statement (not applied); only Worker cleanup may close it:');
    log(`  ${verificationRunStatement({ runId: request.runId, now: request.now })}`);
    return 0;
  }

  if (request.mode === 'dispatch' || request.mode === 'confirm') {
    if (!request.runId) {
      log(`--run-id is required in ${request.mode} mode.`);
      return 1;
    }
  }

  if (request.mode === 'dispatch') {
    if (!request.payloadFile) {
      printRead(log, dispatchSql(request.runId!));
      return 0;
    }
    const observed = parseDispatchPayload(readPayload(request.payloadFile));
    const batch = buildDispatchBatch({
      runId: request.runId!,
      rows: observed.rows,
      nonterminal: observed.nonterminal,
      activeRuns: observed.activeRuns,
      minuteClaims: observed.minuteClaims,
      latestClaimAt: observed.latestClaimAt,
      now: request.now,
    });
    log(`${observed.rows.length} committed pending rows; ${observed.nonterminal} nonterminal,`
      + ` ${observed.retryable} retryable, ${observed.activeRuns} other active runs,`
      + ` ${observed.minuteClaims} claims this minute.`);
    log(`${batch.create.length} would be triggered, not before ${batch.notBefore}`
      + ` (limited by ${batch.limitingBound}).`);
    if (observed.retryable > 0) {
      log('Retryable failures are restarted by Worker reconciliation, never from here.');
    }
    if (!request.confirmed) {
      log('Set CANDIDARY_COVER_BACKFILL_CONFIRM to write the dispatch artifact.');
      return 0;
    }
    if (!request.planFile) {
      log('--plan-file is required in dispatch mode.');
      return 1;
    }
    if (!requireAccount()) return 1;
    if (batch.create.length === 0) {
      log('No row is dispatchable right now; no artifact was written.');
      return 0;
    }
    const sqlFile = sqlPathFor(request.planFile);
    writeArtifact(sqlFile, `${batch.claimStatements.join('\n')}\n`);
    // The four ordered parts, in the order they must be run: claim, trigger,
    // post-trigger read and confirm, then a receipt read that proves the
    // generation and dispatch state the unit actually left behind.
    const readFor = (row: DurableDispatchRow) => d1ReadCommands(
      confirmSql({ runId: request.runId!, jobId: row.jobId, eventId: row.eventId }),
    );
    const steps = [
      ...identityCheckCommands().map((command) => ({ kind: 'identity-check', command })),
      { kind: 'claim', command: d1FileCommand(sqlFile) },
      ...batch.create.map((row, index) => ({
        kind: 'trigger',
        jobId: row.jobId,
        eventId: row.eventId,
        workflowInstanceId: row.workflowInstanceId,
        // The generation the claim moves this job to, which is the one the
        // confirm step must be run with.
        dispatchGeneration: row.dispatchGeneration + 1,
        command: batch.commands[index]!,
        powershellCommand: batch.powershellCommands[index]!,
      })),
      ...batch.create.map((row) => ({
        kind: 'confirm-read',
        jobId: row.jobId,
        confirmWith: `npm run cover-backfill:confirm -- --run-id ${request.runId}`
          + ` --job-id ${row.jobId} --event-id ${row.eventId}`
          + ` --generation ${row.dispatchGeneration + 1}`,
        command: readFor(row).posix,
        powershellCommand: readFor(row).powershell,
      })),
      ...batch.create.map((row) => ({
        kind: 'receipt-read',
        jobId: row.jobId,
        command: readFor(row).posix,
        powershellCommand: readFor(row).powershell,
      })),
    ].map((step, index) => ({ order: index + 1, ...step }));
    writeArtifact(request.planFile, `${JSON.stringify({
      kind: DISPATCH_ARTIFACT_KIND,
      version: ARTIFACT_VERSION,
      runId: request.runId,
      identity,
      generatedAt: request.now,
      notBefore: batch.notBefore,
      withheld: batch.withheld,
      limitingBound: batch.limitingBound,
      steps,
    }, null, 2)}\n`);
    log(`Wrote a dispatch artifact for ${batch.create.length} committed rows to ${request.planFile}`);
    log(`and its fence claim to ${sqlFile}. Applying either is a separately authorized activity.`);
    return 0;
  }

  if (request.mode === 'confirm') {
    if (!request.jobId || !request.eventId || request.generation === null) {
      log('--job-id, --event-id, and --generation are required in confirm mode.');
      return 1;
    }
    if (!request.payloadFile) {
      printRead(log, confirmSql({
        runId: request.runId!, jobId: request.jobId, eventId: request.eventId,
      }));
      return 0;
    }
    const plan = evaluateConfirmation(parseConfirmPayload(readPayload(request.payloadFile)), {
      runId: request.runId!,
      jobId: request.jobId,
      eventId: request.eventId,
      generation: request.generation,
      now: request.now,
    });
    log(`Confirmation outcome: ${plan.outcome}.`);
    for (const reason of plan.reasons) log(`  ${reason}`);
    if (plan.statements.length === 0) {
      log('No mutation is authorized by this read.');
      return plan.outcome === 'confirm' ? 0 : 1;
    }
    if (!request.confirmed) {
      log('Set CANDIDARY_COVER_BACKFILL_CONFIRM to write the confirmation artifact.');
      for (const statement of plan.statements) log(`  ${statement}`);
      return 0;
    }
    if (!request.planFile) {
      log('--plan-file is required to write a confirmation artifact.');
      return 1;
    }
    if (!requireAccount()) return 1;
    const sqlFile = sqlPathFor(request.planFile);
    writeArtifact(sqlFile, `${plan.statements.join('\n')}\n`);
    const steps = [
      ...identityCheckCommands().map((command) => ({ kind: 'identity-check', command })),
      ...plan.commands.map((command) => ({ kind: 'terminate', command })),
      { kind: 'apply', command: d1FileCommand(sqlFile) },
      {
        kind: 'receipt-read',
        command: d1ReadCommands(confirmSql({
          runId: request.runId!, jobId: request.jobId, eventId: request.eventId,
        })).posix,
      },
    ].map((step, index) => ({ order: index + 1, ...step }));
    writeArtifact(request.planFile, `${JSON.stringify({
      kind: CONFIRM_ARTIFACT_KIND,
      version: ARTIFACT_VERSION,
      runId: request.runId,
      jobId: request.jobId,
      eventId: request.eventId,
      generation: request.generation,
      outcome: plan.outcome,
      identity,
      generatedAt: request.now,
      notBefore: request.now,
      steps,
    }, null, 2)}\n`);
    log(`Wrote a ${plan.outcome} artifact to ${request.planFile} and its SQL to ${sqlFile}.`);
    return 0;
  }

  if (!request.payloadFile) {
    printRead(log, inventorySql(request.cursor));
    return 0;
  }

  // Resuming a run means adopting its durable cursor and digest, so the saved
  // run-state read is required rather than inferred.
  let runState: RunStateRow | null = null;
  if (request.runId) {
    if (!request.runStateFile) {
      log(`--run-state-file is required to resume a run. Read it with:`);
      log(`  ${d1ReadCommands(runStateSql(request.runId)).posix}`);
      return 1;
    }
    runState = parseRunStatePayload(readPayload(request.runStateFile));
  } else if (request.runStateFile) {
    log('--run-state-file needs the --run-id it describes.');
    return 1;
  }

  const runId = request.runId ?? randomUUID();
  const rows = parseInventoryPayload(readPayload(request.payloadFile));
  const plan = buildBackfillRunPlan({ runId, rows, now: request.now, runState });

  if (request.mode === 'inventory') {
    log(`Inventoried ${rows.length} legacy cover rows for run ${runId}.`);
    log(`Rolling digest ${plan.inventorySha256 ?? '(none)'}; next cursor ${plan.cursor ?? '(end)'}.`);
    if (plan.inventoryExhausted) {
      log('This page was empty: applying the statement below closes inventory for this run.');
    }
    log('Ledger statements (not applied):');
    for (const statement of plan.statements) log(`  ${statement}`);
    return 0;
  }

  if (!request.confirmed) {
    log(`Dry run. ${plan.statements.length} ledger statements and no Workflow command would be`
      + ` emitted for ${plan.jobs.length} job rows.`);
    log('Set CANDIDARY_COVER_BACKFILL_CONFIRM to write the execute plan.');
    return 0;
  }
  if (!request.planFile) {
    log('--plan-file is required in execute mode.');
    return 1;
  }
  if (!requireAccount()) return 1;
  const sqlFile = sqlPathFor(request.planFile);
  writeArtifact(sqlFile, `${plan.statements.join('\n')}\n`);
  writeArtifact(request.planFile, `${JSON.stringify({
    kind: EXECUTE_ARTIFACT_KIND,
    version: ARTIFACT_VERSION,
    runId,
    identity,
    generatedAt: request.now,
    notBefore: request.now,
    cursor: plan.cursor,
    inventorySha256: plan.inventorySha256,
    inventoryExhausted: plan.inventoryExhausted,
    jobCount: plan.jobs.length,
    steps: [
      ...identityCheckCommands().map((command) => ({ kind: 'identity-check', command })),
      { kind: 'ledger', command: d1FileCommand(sqlFile) },
      { kind: 'run-state-read', command: d1ReadCommands(runStateSql(runId)).posix },
    ].map((step, index) => ({ order: index + 1, ...step })),
  }, null, 2)}\n`);
  log(`Wrote a ledger-only execute plan for ${plan.jobs.length} job rows to ${request.planFile}`);
  log(`and its SQL to ${sqlFile}. Dispatch is a separate mode over committed rows.`);
  return 0;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cover backfill planning failed.');
    process.exitCode = 1;
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as ConstantsModule from '../shared/constants';

/**
 * The legacy-cover backfill launcher: inventory, execute, verify.
 *
 * A planner, not a driver — the same shape as `scripts/event-start-backfill.ts`.
 * It reads `wrangler d1 execute --json` output and emits the exact SQL and
 * instance-create commands an operator then runs. Nothing here opens a
 * connection, mutates a database, or creates a Workflow instance, which is what
 * makes every bound below testable without a network and what keeps a mistyped
 * flag from being a production event.
 *
 * `inventory` is the default and is read-only. `execute` emits mutating
 * artifacts only when `CANDIDARY_COVER_BACKFILL_CONFIRM` is set, mirroring the
 * load harnesses; without it the mode prints the plan it *would* emit and stops.
 *
 * The four bounds are enforced here rather than trusted to an operator's
 * patience: at most one page of inventory, at most one 25-instance batch, never
 * more than 25 jobs nonterminal, and never more than 25 creates in a minute.
 */

const constantsModulePath = '../shared/constants.ts';
const constants = await import(constantsModulePath) as typeof ConstantsModule;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const COVER_BACKFILL_WORKFLOW_NAME = 'candidary-cover-backfill';

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

export type CoverBackfillMode = 'inventory' | 'execute' | 'verify';

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

export interface BackfillRunPlan {
  runId: string;
  cursor: string | null;
  inventorySha256: string;
  jobs: PlannedJob[];
  /** Read-only when the plan is a dry run; the caller decides whether to apply. */
  statements: string[];
}

export interface DispatchBatch {
  create: PlannedJob[];
  /** POSIX-quoted `wrangler workflows trigger` invocations. */
  commands: string[];
  /** The same invocations quoted for PowerShell, which this repository uses. */
  powershellCommands: string[];
  fenceStatements: string[];
  withheldForInFlight: number;
  withheldForBatch: number;
}

/* ------------------------------------------------------------------ *
 * Read-only SQL
 * ------------------------------------------------------------------ */

function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
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

/** The job-status counts `execute` needs before it may create anything. */
export function inFlightSql(runId: string): string {
  if (!UUID_PATTERN.test(runId)) throw new Error('The run ID must be a UUID.');
  return 'SELECT status, count(*) AS value FROM event_cover_backfill_jobs'
    + ` WHERE run_id = ${sqlString(runId)} GROUP BY status;`;
}

/* ------------------------------------------------------------------ *
 * Payload parsing
 * ------------------------------------------------------------------ */

function firstResultArray(payload: unknown): unknown[] {
  // `wrangler d1 execute --json` answers with an array of per-statement
  // envelopes; a bare array of rows is accepted too so a hand-saved payload
  // does not have to be reshaped.
  if (Array.isArray(payload)) {
    const first = payload[0];
    if (first && typeof first === 'object' && 'results' in first) {
      const results = (first as { results: unknown }).results;
      if (Array.isArray(results)) return results;
      throw new Error('The payload envelope has no results array.');
    }
    return payload;
  }
  if (payload && typeof payload === 'object' && 'results' in payload) {
    const results = (payload as { results: unknown }).results;
    if (Array.isArray(results)) return results;
  }
  throw new Error('The payload is not a wrangler d1 execute --json result.');
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
    const record = row as Record<string, unknown>;
    const id = record['id'];
    const key = record['cover_object_key'];
    const revision = record['cover_revision'];
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
    const record = row as Record<string, unknown>;
    const name = record['name'] ?? record['status'];
    const value = record['value'];
    if (typeof name !== 'string' || typeof value !== 'number') {
      throw new Error('A count payload row has no name/value pair.');
    }
    counts[name] = value;
  }
  return counts;
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

function hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
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
 * A digest of exactly what was inventoried, in inventory order.
 *
 * Over the event ID and its key fingerprint rather than the key itself, so the
 * digest can be recorded and compared without a server-only key ever entering an
 * artifact an operator might paste somewhere.
 */
export function inventoryDigest(rows: readonly InventoryRow[]): string {
  return hex(rows.map((row) => `${row.id}:${fingerprintKey(row.cover_object_key)}`).join('\n'));
}

/* ------------------------------------------------------------------ *
 * Plans
 * ------------------------------------------------------------------ */

export function buildBackfillRunPlan(input: {
  runId: string;
  rows: readonly InventoryRow[];
  now: string;
  newRun: boolean;
  makeJobId?: () => string;
}): BackfillRunPlan {
  if (!UUID_PATTERN.test(input.runId)) throw new Error('The run ID must be a UUID.');
  if (!ISO_INSTANT_PATTERN.test(input.now)) throw new Error('The timestamp must be a UTC instant.');
  if (input.rows.length > constants.MAX_COVER_BACKFILL_PAGE_SIZE) {
    throw new Error('An inventory page may not exceed the page size.');
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
  const inventorySha256 = inventoryDigest(input.rows);
  const dependencies = JSON.stringify(COVER_BACKFILL_DEPENDENCY_VERSIONS);

  const statements: string[] = [];
  if (input.newRun) {
    statements.push(
      'INSERT INTO event_cover_backfill_runs (id, mode, cursor, inventory_sha256, status, created_at, updated_at)'
      + ` VALUES (${sqlString(input.runId)}, 'inventory', ${cursor === null ? 'NULL' : sqlString(cursor)},`
      + ` ${sqlString(inventorySha256)}, 'inventorying', ${sqlString(input.now)}, ${sqlString(input.now)});`,
    );
  } else {
    statements.push(
      'UPDATE event_cover_backfill_runs'
      + ` SET cursor = ${cursor === null ? 'NULL' : sqlString(cursor)},`
      + ` inventory_sha256 = ${sqlString(inventorySha256)}, updated_at = ${sqlString(input.now)}`
      + ` WHERE id = ${sqlString(input.runId)};`,
    );
  }

  for (const job of jobs) {
    statements.push(
      'INSERT INTO event_cover_backfill_jobs ('
      + 'id, run_id, event_id, expected_revision, legacy_key_fingerprint, workflow_instance_id,'
      + ' dispatch_state, dispatch_generation, status, dependency_versions_json, created_at, updated_at)'
      + ` SELECT ${sqlString(job.jobId)}, ${sqlString(input.runId)}, ${sqlString(job.eventId)},`
      + ` ${job.expectedRevision}, ${sqlString(job.legacyKeyFingerprint)},`
      + ` ${sqlString(job.workflowInstanceId)}, 'pending', 0, 'queued', ${sqlString(dependencies)},`
      + ` ${sqlString(input.now)}, ${sqlString(input.now)}`
      // Re-inventorying an event that has since been converted, or that already
      // has a live job in this run, must not allocate a second one.
      + ' WHERE EXISTS (SELECT 1 FROM events WHERE id = ' + sqlString(job.eventId)
      + ' AND deleted_at IS NULL AND cover_object_key IS NOT NULL AND cover_render_set_id IS NULL'
      + ` AND cover_revision = ${job.expectedRevision})`
      + ' AND NOT EXISTS (SELECT 1 FROM event_cover_backfill_jobs'
      + ` WHERE run_id = ${sqlString(input.runId)} AND event_id = ${sqlString(job.eventId)});`,
    );
  }

  return { runId: input.runId, cursor, inventorySha256, jobs, statements };
}

/**
 * One bounded dispatch batch.
 *
 * Three bounds compose into one capacity, and the tightest wins: never more than
 * one batch, never more than one minute's creates, and never more than the
 * in-flight ceiling minus what is already running. A run that is already at the
 * ceiling creates nothing at all rather than creating one more.
 */
export function buildDispatchBatch(input: {
  runId: string;
  queued: readonly PlannedJob[];
  nonterminal: number;
  now: string;
}): DispatchBatch {
  if (!UUID_PATTERN.test(input.runId)) throw new Error('The run ID must be a UUID.');
  if (input.nonterminal < 0) throw new Error('The nonterminal count cannot be negative.');

  const headroom = constants.MAX_COVER_BACKFILL_IN_FLIGHT - input.nonterminal;
  if (headroom <= 0) {
    return {
      create: [],
      commands: [],
      powershellCommands: [],
      fenceStatements: [],
      withheldForInFlight: input.queued.length,
      withheldForBatch: 0,
    };
  }
  const capacity = Math.min(
    headroom,
    constants.MAX_COVER_BACKFILL_CREATE_BATCH,
    constants.MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
  );
  const create = input.queued.slice(0, capacity);

  const fenceStatements = create.map((job) => (
    'INSERT INTO event_cover_workflow_fences ('
    + 'workflow_binding, workflow_instance_id, event_id, dispatch_generation, state,'
    + ' created_at, updated_at, expires_at)'
    + ` VALUES ('COVER_BACKFILL_WORKFLOW', ${sqlString(job.workflowInstanceId)},`
    + ` ${sqlString(job.eventId)}, 0, 'open', ${sqlString(input.now)}, ${sqlString(input.now)},`
    + ` ${sqlString(new Date(Date.parse(input.now) + 31 * 24 * 60 * 60 * 1000).toISOString())})`
    + ' ON CONFLICT (workflow_binding, workflow_instance_id) DO NOTHING;'
  ));

  // Read off `wrangler workflows --help` at 4.113.0 rather than assumed: there is
  // no `workflows instances create`. The instance subcommands are list, describe,
  // send-event, terminate, restart, pause, and resume; creation is `trigger`,
  // whose params are a positional JSON string and whose `--id` is the only way to
  // give an instance the deterministic ID the fence is keyed by.
  const commands = create.map((job) => {
    const params = JSON.stringify({
      runId: input.runId,
      jobId: job.jobId,
      eventId: job.eventId,
    });
    // Single-quoted for POSIX; PowerShell needs the doubled-quote form, so both
    // are emitted rather than leaving an operator to discover that their shell
    // silently ate the payload and created an instance with no parameters.
    return `npx wrangler workflows trigger ${COVER_BACKFILL_WORKFLOW_NAME} '${params}'`
      + ` --id ${job.workflowInstanceId}`;
  });

  const powershellCommands = create.map((job) => {
    const params = JSON.stringify({
      runId: input.runId,
      jobId: job.jobId,
      eventId: job.eventId,
    }).replace(/"/gu, '""');
    return `npx wrangler workflows trigger ${COVER_BACKFILL_WORKFLOW_NAME} "${params}"`
      + ` --id ${job.workflowInstanceId}`;
  });

  return {
    create,
    commands,
    powershellCommands,
    fenceStatements,
    withheldForInFlight: 0,
    withheldForBatch: input.queued.length - create.length,
  };
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
  runId: string | null;
  cursor: string | null;
  now: string;
  confirmed: boolean;
}

export function parseCoverBackfillArgs(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): CoverBackfillRequest {
  const [first, ...rest] = args;
  const mode: CoverBackfillMode = first === 'execute' || first === 'verify' || first === 'inventory'
    ? first
    : first === undefined
      ? 'inventory'
      : (() => { throw new Error(`Unknown mode ${first}. Use inventory, execute, or verify.`); })();

  const request: CoverBackfillRequest = {
    mode,
    payloadFile: null,
    planFile: null,
    runId: null,
    cursor: null,
    now: new Date().toISOString(),
    confirmed: Boolean(env['CANDIDARY_COVER_BACKFILL_CONFIRM']),
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === '--payload-file' || flag === '--plan-file' || flag === '--run-id'
      || flag === '--cursor' || flag === '--now') {
      if (value === undefined) throw new Error(`${flag} needs a value.`);
      index += 1;
      if (flag === '--payload-file') request.payloadFile = value;
      if (flag === '--plan-file') request.planFile = value;
      if (flag === '--run-id') request.runId = value;
      if (flag === '--cursor') request.cursor = value;
      if (flag === '--now') request.now = value;
      continue;
    }
    throw new Error(`Unknown argument ${String(flag)}.`);
  }
  return request;
}

function readPayload(file: string): unknown {
  return JSON.parse(readFileSync(resolve(PROJECT_ROOT, file), 'utf8')) as unknown;
}

export function runCli(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  log: (message: string) => void = console.log,
): number {
  const request = parseCoverBackfillArgs(args, env);

  if (request.mode === 'verify') {
    if (!request.payloadFile) {
      log('Run this read-only statement with `wrangler d1 execute candidary-core --json`,');
      log('then pass its output back with --payload-file:');
      log(proofSql());
      return 0;
    }
    const evaluation = evaluateZeroLegacyProof(readPayload(request.payloadFile));
    log(JSON.stringify(evaluation, null, 2));
    if (!evaluation.proven) {
      log('The zero-legacy proof is red. Phase 3 is not authorized.');
      return 1;
    }
    log('The zero-legacy proof is green. Phase 3 remains a separately authorized release activity.');
    return 0;
  }

  if (!request.payloadFile) {
    log('Run this read-only statement with `wrangler d1 execute candidary-core --json`,');
    log('then pass its output back with --payload-file:');
    log(inventorySql(request.cursor));
    return 0;
  }

  const runId = request.runId ?? randomUUID();
  const rows = parseInventoryPayload(readPayload(request.payloadFile));
  const plan = buildBackfillRunPlan({
    runId,
    rows,
    now: request.now,
    newRun: request.runId === null,
  });

  if (request.mode === 'inventory') {
    log(`Inventoried ${rows.length} legacy cover rows for run ${runId}.`);
    log(`Inventory digest ${plan.inventorySha256}; next cursor ${plan.cursor ?? '(end)'}.`);
    log('Ledger statements (not applied):');
    for (const statement of plan.statements) log(`  ${statement}`);
    return 0;
  }

  const batch = buildDispatchBatch({ runId, queued: plan.jobs, nonterminal: 0, now: request.now });
  if (!request.confirmed) {
    log(`Dry run. ${plan.jobs.length} job rows and ${batch.create.length} instance creates would be emitted.`);
    log('Set CANDIDARY_COVER_BACKFILL_CONFIRM to write the execute plan.');
    return 0;
  }
  if (!request.planFile) {
    log('--plan-file is required in execute mode.');
    return 1;
  }
  writeFileSync(
    resolve(PROJECT_ROOT, request.planFile),
    `${JSON.stringify({
      kind: 'candidary-cover-backfill-execute-plan',
      runId,
      generatedAt: request.now,
      inventorySha256: plan.inventorySha256,
      cursor: plan.cursor,
      statements: [...plan.statements, ...batch.fenceStatements],
      commands: batch.commands,
      powershellCommands: batch.powershellCommands,
      withheldForBatch: batch.withheldForBatch,
    }, null, 2)}\n`,
    'utf8',
  );
  log(`Wrote an execute plan for ${batch.create.length} instances to ${request.planFile}.`);
  log('Applying it is a separately authorized release activity.');
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

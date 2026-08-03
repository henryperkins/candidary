import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type * as EventTimeModule from '../shared/event-time';

// Node 24's native TypeScript loader needs the runtime `.ts` suffix, while the
// repository typecheck intentionally does not enable TypeScript-extension
// imports. Keeping the runtime path computed lets both tools use their native
// resolution without weakening the shared compiler configuration.
const eventTimeModulePath = '../shared/event-time.ts';
const { instantForLocalDateTime } = await import(eventTimeModulePath) as typeof EventTimeModule;

const PLAN_KIND = 'candidary-event-start-backfill' as const;
const PLAN_VERSION = 1 as const;
const EPOCH_SENTINEL = '1970-01-01T00:00:00.000Z';
const SCHEDULE_FREEZE_TRIGGER_NAME = 'candidary_event_start_schedule_freeze';
const SCHEDULE_FREEZE_ERROR = 'CANDIDARY_EVENT_START_RELEASE_SCHEDULE_FROZEN';
const SCHEDULE_FREEZE_STATEMENT = `CREATE TRIGGER ${SCHEDULE_FREEZE_TRIGGER_NAME}
BEFORE UPDATE OF event_date, event_timezone, rsvp_deadline_at ON events
FOR EACH ROW
WHEN OLD.event_date IS NOT NEW.event_date
  OR OLD.event_timezone IS NOT NEW.event_timezone
  OR OLD.rsvp_deadline_at IS NOT NEW.rsvp_deadline_at
BEGIN
  SELECT RAISE(ABORT, '${SCHEDULE_FREEZE_ERROR}');
END`;
const SCHEDULE_FREEZE_INSTALL_SQL = [
  '-- Temporary release gate: blocks only actual schedule-source changes.',
  '-- Inserts, derived event_start_at writes, and unrelated updates remain available.',
  `${SCHEDULE_FREEZE_STATEMENT};`,
  '',
].join('\n');
const SCHEDULE_FREEZE_REMOVE_SQL = [
  '-- Release cleanup or explicit abort. Removing this freeze invalidates prior verification.',
  `DROP TRIGGER IF EXISTS ${SCHEDULE_FREEZE_TRIGGER_NAME};`,
  '',
].join('\n');

type JsonRecord = Record<string, unknown>;

export interface InventoryRow extends JsonRecord {
  id: string;
  slug?: string;
  event_date?: string;
  event_timezone?: string;
  rsvp_deadline_at?: string | null;
  event_start_at?: string | null;
  deleted_at?: string | null;
}

export interface BackfillPlanEvent {
  id: string;
  eventDate: string;
  eventTimezone: string;
  rsvpDeadlineAt: string | null;
  expectedEventStartAt: string;
}

export interface BackfillPlan {
  kind: typeof PLAN_KIND;
  version: typeof PLAN_VERSION;
  events: BackfillPlanEvent[];
}

export interface BackfillArtifacts {
  plan: BackfillPlan;
  planJson: string;
  sql: string;
}

export type VerificationIssueKind =
  | 'missing'
  | 'duplicate'
  | 'epoch-sentinel'
  | 'utc-midnight-approximation'
  | 'source-mismatch'
  | 'unplanned-non-sentinel'
  | 'mismatch';

export type InventorySourceField =
  | 'event_date'
  | 'event_timezone'
  | 'rsvp_deadline_at';

export interface VerificationIssue {
  id: string;
  kind: VerificationIssueKind;
  field?: InventorySourceField;
  expected: string | null;
  actual: string | null;
}

export interface VerificationResult {
  ok: boolean;
  verifiedCount: number;
  issues: VerificationIssue[];
}

export interface VerificationOptions {
  requireNoSentinel?: boolean;
  requirePredeployCompleteness?: boolean;
}

export type FreezeExpectation = 'installed' | 'absent';

export interface FreezeStateResult {
  ok: boolean;
  message: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsFrom(value: unknown, context: string): InventoryRow[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${context} must be an array of row objects.`);
  }
  return value.map((row, index) => {
    if (!isRecord(row)) {
      throw new TypeError(`${context} row ${index + 1} must be an object.`);
    }
    return row as InventoryRow;
  });
}

/**
 * Accepts the direct JSON row array used by fixtures as well as the array of
 * `{ results, success, meta }` statement envelopes emitted by
 * `wrangler d1 execute --json`.
 */
export function parseInventoryPayload(payload: unknown): InventoryRow[] {
  if (isRecord(payload) && Array.isArray(payload.results)) {
    if (payload.success === false) {
      throw new Error('Wrangler reported that the inventory query failed.');
    }
    return recordsFrom(payload.results, 'Wrangler results');
  }
  if (!Array.isArray(payload)) {
    throw new TypeError('Inventory JSON must be a row array or Wrangler d1 JSON output.');
  }
  if (payload.length === 0) return [];

  const looksLikeWrangler = payload.every(
    (entry) => isRecord(entry) && Array.isArray(entry.results),
  );
  if (!looksLikeWrangler) return recordsFrom(payload, 'Inventory');

  const rows: InventoryRow[] = [];
  for (const [index, envelope] of payload.entries()) {
    if (!isRecord(envelope) || !Array.isArray(envelope.results)) {
      throw new TypeError(`Wrangler statement ${index + 1} has no results array.`);
    }
    if (envelope.success === false) {
      throw new Error(`Wrangler statement ${index + 1} reported failure.`);
    }
    rows.push(...recordsFrom(envelope.results, `Wrangler statement ${index + 1}`));
  }
  return rows;
}

function requireString(row: InventoryRow, key: keyof InventoryRow, id?: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    const rowLabel = id ? `Event ${JSON.stringify(id)}` : 'Inventory row';
    throw new TypeError(`${rowLabel} needs a non-empty ${String(key)} string.`);
  }
  return value;
}

function deadlineFor(row: InventoryRow, id: string): string | null {
  const value = row.rsvp_deadline_at;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Event ${JSON.stringify(id)} has an unreadable rsvp_deadline_at.`);
  }
  return value;
}

function compareIds(left: { id: string }, right: { id: string }): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderSql(events: BackfillPlanEvent[]): string {
  const lines = [
    `-- Candidary event-start backfill plan v${PLAN_VERSION}.`,
    '-- Review this deterministic artifact before applying it with Wrangler.',
    '-- This generator never connects to or mutates D1.',
    '',
  ];
  for (const event of events) {
    const utcMidnightApproximation = `${event.eventDate}T00:00:00.000Z`;
    const deadlineGuard = event.rsvpDeadlineAt === null
      ? 'rsvp_deadline_at IS NULL'
      : `rsvp_deadline_at = ${sqlString(event.rsvpDeadlineAt)}`;
    lines.push(
      `UPDATE events SET event_start_at = ${sqlString(event.expectedEventStartAt)} WHERE id = ${sqlString(event.id)} AND deleted_at IS NULL AND event_date = ${sqlString(event.eventDate)} AND event_timezone = ${sqlString(event.eventTimezone)} AND ${deadlineGuard} AND event_start_at IN (${sqlString(EPOCH_SENTINEL)}, ${sqlString(utcMidnightApproximation)});`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function normalizedSql(value: string): string {
  return value.trim().replace(/;$/u, '').replace(/\s+/gu, ' ');
}

export function verifyScheduleFreezeState(
  rows: InventoryRow[],
  expectation: FreezeExpectation,
): FreezeStateResult {
  const matching = rows.filter((row) => row.name === SCHEDULE_FREEZE_TRIGGER_NAME);
  if (expectation === 'absent') {
    if (matching.length === 0) {
      return { ok: true, message: 'Schedule freeze trigger is absent.' };
    }
    return {
      ok: false,
      message: `Schedule freeze trigger ${SCHEDULE_FREEZE_TRIGGER_NAME} is still installed.`,
    };
  }

  if (matching.length !== 1) {
    return {
      ok: false,
      message: `Expected exactly one ${SCHEDULE_FREEZE_TRIGGER_NAME} trigger; found ${matching.length}.`,
    };
  }
  const storedSql = matching[0]!.sql;
  if (
    typeof storedSql !== 'string'
    || normalizedSql(storedSql) !== normalizedSql(SCHEDULE_FREEZE_STATEMENT)
  ) {
    return {
      ok: false,
      message: `Schedule freeze trigger ${SCHEDULE_FREEZE_TRIGGER_NAME} definition does not match the reviewed release gate.`,
    };
  }
  return { ok: true, message: 'Exact schedule freeze trigger is installed.' };
}

export function buildBackfillArtifacts(rows: InventoryRow[]): BackfillArtifacts {
  const events: BackfillPlanEvent[] = [];
  const seenIds = new Set<string>();

  for (const row of rows) {
    if (row.deleted_at !== undefined && row.deleted_at !== null) continue;

    const id = requireString(row, 'id');
    if (seenIds.has(id)) {
      throw new Error(`Inventory contains duplicate event ID ${JSON.stringify(id)}.`);
    }
    seenIds.add(id);

    const eventDate = requireString(row, 'event_date', id);
    const eventTimezone = requireString(row, 'event_timezone', id);
    const rsvpDeadlineAt = deadlineFor(row, id);

    let expectedEventStartAt: string;
    try {
      expectedEventStartAt = instantForLocalDateTime(eventDate, '00:00', eventTimezone);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RangeError(
        `Event ${JSON.stringify(id)} cannot resolve local midnight: ${detail}`,
        { cause: error },
      );
    }

    if (
      rsvpDeadlineAt !== null
      && Date.parse(rsvpDeadlineAt) >= Date.parse(expectedEventStartAt)
    ) {
      throw new RangeError(
        `Event ${JSON.stringify(id)} has RSVP deadline ${rsvpDeadlineAt}; it must be strictly before expected start ${expectedEventStartAt}. Resolve the deadline before generating SQL.`,
      );
    }

    events.push({
      id,
      eventDate,
      eventTimezone,
      rsvpDeadlineAt,
      expectedEventStartAt,
    });
  }

  events.sort(compareIds);
  const plan: BackfillPlan = { kind: PLAN_KIND, version: PLAN_VERSION, events };
  return {
    plan,
    planJson: `${JSON.stringify(plan, null, 2)}\n`,
    sql: renderSql(events),
  };
}

function assertPlan(value: unknown): asserts value is BackfillPlan {
  if (!isRecord(value) || value.kind !== PLAN_KIND || value.version !== PLAN_VERSION) {
    throw new TypeError(`Plan must be ${PLAN_KIND} version ${PLAN_VERSION}.`);
  }
  if (!Array.isArray(value.events)) {
    throw new TypeError('Plan events must be an array.');
  }
  const seenIds = new Set<string>();
  for (const [index, candidate] of value.events.entries()) {
    if (!isRecord(candidate)) {
      throw new TypeError(`Plan event ${index + 1} must be an object.`);
    }
    for (const key of ['id', 'eventDate', 'eventTimezone', 'expectedEventStartAt'] as const) {
      if (typeof candidate[key] !== 'string' || candidate[key].length === 0) {
        throw new TypeError(`Plan event ${index + 1} needs a non-empty ${key} string.`);
      }
    }
    if (candidate.rsvpDeadlineAt !== null && typeof candidate.rsvpDeadlineAt !== 'string') {
      throw new TypeError(`Plan event ${index + 1} has an invalid rsvpDeadlineAt.`);
    }
    if (seenIds.has(candidate.id as string)) {
      throw new TypeError(`Plan contains duplicate event ID ${JSON.stringify(candidate.id)}.`);
    }
    seenIds.add(candidate.id as string);
  }
}

export function verifyBackfillPlan(
  plan: BackfillPlan,
  rows: InventoryRow[],
  options: VerificationOptions = {},
): VerificationResult {
  assertPlan(plan);

  const rowsById = new Map<string, InventoryRow[]>();
  for (const row of rows) {
    if (row.deleted_at !== undefined && row.deleted_at !== null) continue;
    if (typeof row.id !== 'string') continue;
    const matching = rowsById.get(row.id) ?? [];
    matching.push(row);
    rowsById.set(row.id, matching);
  }

  const issues: VerificationIssue[] = [];
  let verifiedCount = 0;
  for (const event of plan.events) {
    const matching = rowsById.get(event.id) ?? [];
    if (matching.length === 0) {
      issues.push({
        id: event.id,
        kind: 'missing',
        expected: event.expectedEventStartAt,
        actual: null,
      });
      continue;
    }
    if (matching.length > 1) {
      issues.push({
        id: event.id,
        kind: 'duplicate',
        expected: event.expectedEventStartAt,
        actual: null,
      });
      continue;
    }

    const row = matching[0]!;
    let sourceMatches = true;
    const sourceFields: Array<{
      field: InventorySourceField;
      expected: string | null;
    }> = [
      { field: 'event_date', expected: event.eventDate },
      { field: 'event_timezone', expected: event.eventTimezone },
      { field: 'rsvp_deadline_at', expected: event.rsvpDeadlineAt },
    ];
    for (const { field, expected } of sourceFields) {
      const rawActual = row[field];
      const actual = typeof rawActual === 'string' || rawActual === null ? rawActual : null;
      if (Object.hasOwn(row, field) && rawActual === expected) continue;
      sourceMatches = false;
      issues.push({
        id: event.id,
        kind: 'source-mismatch',
        field,
        expected,
        actual,
      });
    }

    const actualValue = row.event_start_at;
    const actual = typeof actualValue === 'string' ? actualValue : null;
    if (actual === event.expectedEventStartAt) {
      if (sourceMatches) verifiedCount += 1;
      continue;
    }

    let kind: VerificationIssueKind = 'mismatch';
    if (actual === EPOCH_SENTINEL) {
      kind = 'epoch-sentinel';
    } else if (actual === `${event.eventDate}T00:00:00.000Z`) {
      kind = 'utc-midnight-approximation';
    }
    issues.push({ id: event.id, kind, expected: event.expectedEventStartAt, actual });
  }

  if (options.requirePredeployCompleteness) {
    const plannedIds = new Set(plan.events.map((event) => event.id));
    for (const id of [...rowsById.keys()].sort()) {
      if (plannedIds.has(id)) continue;
      const nonSentinel = rowsById.get(id)!.find(
        (row) => row.event_start_at !== EPOCH_SENTINEL,
      );
      if (!nonSentinel) continue;
      const actual = typeof nonSentinel.event_start_at === 'string'
        ? nonSentinel.event_start_at
        : null;
      issues.push({
        id,
        kind: 'unplanned-non-sentinel',
        expected: null,
        actual,
      });
    }
  }

  if (options.requireNoSentinel) {
    const issueIds = new Set(
      issues
        .filter((issue) => issue.kind === 'epoch-sentinel')
        .map((issue) => issue.id),
    );
    const expectedById = new Map(
      plan.events.map((event) => [event.id, event.expectedEventStartAt]),
    );
    const sentinelIds = new Set<string>();
    for (const row of rows) {
      if (row.deleted_at !== undefined && row.deleted_at !== null) continue;
      if (typeof row.id !== 'string' || row.event_start_at !== EPOCH_SENTINEL) continue;
      sentinelIds.add(row.id);
    }
    for (const id of [...sentinelIds].sort()) {
      if (issueIds.has(id)) continue;
      issues.push({
        id,
        kind: 'epoch-sentinel',
        expected: expectedById.get(id) ?? null,
        actual: EPOCH_SENTINEL,
      });
    }
  }

  return { ok: issues.length === 0, verifiedCount, issues };
}

function decodeJsonFile(path: string): unknown {
  const contents = readFileSync(path);
  let text: string;
  if (contents[0] === 0xff && contents[1] === 0xfe) {
    text = contents.subarray(2).toString('utf16le');
  } else if (contents[0] === 0xef && contents[1] === 0xbb && contents[2] === 0xbf) {
    text = contents.subarray(3).toString('utf8');
  } else {
    text = contents.toString('utf8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(
      `Could not parse JSON file ${JSON.stringify(path)}: ${detail}`,
      { cause: error },
    );
  }
}

function optionValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length || args[index + 1]!.startsWith('--')) {
    throw new TypeError(`Missing required ${name} path.`);
  }
  return args[index + 1]!;
}

function usage(): string {
  return [
    'Usage:',
    '  event-start-backfill.ts plan --input <inventory.json> --plan <plan.json> --sql <backfill.sql>',
    '  event-start-backfill.ts verify --plan <plan.json> --input <post-inventory.json> [--require-predeploy-completeness] [--require-no-sentinel]',
    '  event-start-backfill.ts freeze --install <install.sql> --remove <remove.sql>',
    '  event-start-backfill.ts verify-freeze --input <trigger-inventory.json> --expect <installed|absent>',
  ].join('\n');
}

function issueMessage(issue: VerificationIssue): string {
  if (issue.kind === 'missing') {
    return `${issue.id}: missing from the post-migration inventory; expected ${issue.expected}`;
  }
  if (issue.kind === 'duplicate') {
    return `${issue.id}: appears more than once in the post-migration inventory`;
  }
  if (issue.kind === 'epoch-sentinel') {
    return `${issue.id}: still has the epoch deploy-gap sentinel ${EPOCH_SENTINEL}; inventory and plan that gap row before release`;
  }
  if (issue.kind === 'utc-midnight-approximation') {
    return `${issue.id}: still has the migration's UTC-midnight approximation ${issue.actual}; apply the reviewed backfill SQL`;
  }
  if (issue.kind === 'source-mismatch') {
    return `${issue.id}: ${issue.field} changed after planning; expected ${issue.expected ?? 'NULL'}, found ${issue.actual ?? 'NULL or missing'}; generate and review a fresh plan`;
  }
  if (issue.kind === 'unplanned-non-sentinel') {
    return `${issue.id}: non-deleted event was not in the plan and has non-sentinel start ${issue.actual ?? 'NULL or unreadable'}; repeat inventory and planning before deployment`;
  }
  return `${issue.id}: expected ${issue.expected}, found ${issue.actual ?? 'NULL or unreadable'}`;
}

export function runCli(args: string[]): number {
  const [mode, ...options] = args;
  if (mode === 'freeze') {
    const installPath = optionValue(options, '--install');
    const removePath = optionValue(options, '--remove');
    writeFileSync(installPath, SCHEDULE_FREEZE_INSTALL_SQL, 'utf8');
    writeFileSync(removePath, SCHEDULE_FREEZE_REMOVE_SQL, 'utf8');
    console.log(
      `Wrote deterministic schedule-freeze install and removal SQL to ${installPath} and ${removePath}. No database command was run.`,
    );
    return 0;
  }

  if (mode === 'verify-freeze') {
    const inputPath = optionValue(options, '--input');
    const rawExpectation = optionValue(options, '--expect');
    if (rawExpectation !== 'installed' && rawExpectation !== 'absent') {
      throw new TypeError('--expect must be either installed or absent.');
    }
    const rows = parseInventoryPayload(decodeJsonFile(inputPath));
    const result = verifyScheduleFreezeState(rows, rawExpectation);
    if (!result.ok) {
      console.error(result.message);
      return 1;
    }
    console.log(result.message);
    return 0;
  }

  if (mode === 'plan') {
    const inputPath = optionValue(options, '--input');
    const planPath = optionValue(options, '--plan');
    const sqlPath = optionValue(options, '--sql');
    const rows = parseInventoryPayload(decodeJsonFile(inputPath));
    const artifacts = buildBackfillArtifacts(rows);
    writeFileSync(planPath, artifacts.planJson, 'utf8');
    writeFileSync(sqlPath, artifacts.sql, 'utf8');
    console.log(
      `Planned ${artifacts.plan.events.length} event start${artifacts.plan.events.length === 1 ? '' : 's'}; wrote ${planPath} and ${sqlPath}. No database command was run.`,
    );
    return 0;
  }

  if (mode === 'verify') {
    const planPath = optionValue(options, '--plan');
    const inputPath = optionValue(options, '--input');
    const plan = decodeJsonFile(planPath);
    assertPlan(plan);
    const rows = parseInventoryPayload(decodeJsonFile(inputPath));
    const result = verifyBackfillPlan(plan, rows, {
      requireNoSentinel: options.includes('--require-no-sentinel'),
      requirePredeployCompleteness: options.includes('--require-predeploy-completeness'),
    });
    if (!result.ok) {
      console.error(`Verification blocked: ${result.issues.length} planned event start issue${result.issues.length === 1 ? '' : 's'}.`);
      for (const issue of result.issues) console.error(`- ${issueMessage(issue)}`);
      return 1;
    }
    console.log(
      `Verified ${result.verifiedCount} planned event start${result.verifiedCount === 1 ? '' : 's'} exactly.`,
    );
    return 0;
  }

  throw new TypeError(usage());
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  COVER_BACKFILL_WORKFLOW_NAME,
  WRANGLER_CONFIG_PATH,
  buildBackfillRunPlan,
  claimedDispatchSql,
  confirmSql,
  dispatchSql,
  evaluateConfirmation,
  inventorySql,
  parseClaimedDispatchPayload,
  parseConfirmPayload,
  parseDispatchPayload,
  parseInventoryPayload,
  parseRunStatePayload,
  proofSql,
  runCli,
  runStateSql,
  type DispatchClaimCandidate,
} from '../../scripts/cover-backfill';

const ACCOUNT = 'cover-backfill-local-rehearsal';
const NOW = '2026-08-08T12:00:00.000Z';
const artifactRoots = new Set<string>();

interface ArtifactStep {
  order: number;
  kind: string;
  command?: string;
  powershellCommand?: string;
  jobId?: string;
  eventId?: string;
  workflowInstanceId?: string;
  dispatchGeneration?: number;
}

interface ExecuteArtifact {
  runId: string;
  cursor: string | null;
  inventorySha256: string;
  inventoryExhausted: boolean;
  jobCount: number;
  steps: ArtifactStep[];
}

interface DispatchArtifact {
  runId: string;
  notBefore: string;
  candidates: DispatchClaimCandidate[];
  steps: ArtifactStep[];
}

interface LaunchArtifact {
  runId: string;
  acceptedCandidates: DispatchClaimCandidate[];
  refusedCandidates: DispatchClaimCandidate[];
  steps: ArtifactStep[];
}

interface ConfirmationArtifact {
  runId: string;
  jobId: string;
  eventId: string;
  generation: number;
  outcome: string;
  steps: ArtifactStep[];
}

interface WranglerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function eventId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  const migrationRoot = resolve(process.cwd(), 'migrations');
  const migrations = readdirSync(migrationRoot)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
  expect(migrations).toHaveLength(13);
  for (const migration of migrations) {
    database.exec(readFileSync(resolve(migrationRoot, migration), 'utf8'));
  }
  return database;
}

function seedLegacyEvents(database: DatabaseSync, count: number): void {
  const insert = database.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message, cover_object_key,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Operator loop', '2026-08-08', 'Welcome', ?, ?, ?, ?, ?)
  `);
  for (let index = 1; index <= count; index += 1) {
    const id = eventId(index);
    insert.run(id, `operator-loop-${index}`, `events/${id}/cover/legacy.jpg`, NOW, NOW, NOW, NOW);
  }
}

function resultPayload(database: DatabaseSync, sql: string): unknown[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => ({
      results: JSON.parse(JSON.stringify(database.prepare(statement).all())) as unknown[],
      success: true,
    }));
}

function applySqlUnit(database: DatabaseSync, sql: string): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(sql);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

function outputRoot(label: string): { absolute: string; relative: string } {
  const relative = `output/cover-backfill-operator-loop-${label}`;
  const absolute = resolve(process.cwd(), relative);
  rmSync(absolute, { force: true, recursive: true });
  mkdirSync(absolute, { recursive: true });
  artifactRoots.add(absolute);
  return { absolute, relative };
}

function savePayload(root: { absolute: string; relative: string }, name: string, payload: unknown): string {
  writeFileSync(resolve(root.absolute, name), `${JSON.stringify(payload)}\n`, 'utf8');
  return `${root.relative}/${name}`;
}

function readArtifact<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8')) as T;
}

function sqlFor(relativePlanPath: string): string {
  return readFileSync(
    resolve(process.cwd(), relativePlanPath.replace(/\.json$/u, '.sql')),
    'utf8',
  );
}

function invoke(args: readonly string[]): string[] {
  const lines: string[] = [];
  expect(runCli(args, { CANDIDARY_COVER_BACKFILL_CONFIRM: '1' }, (line) => lines.push(line)))
    .toBe(0);
  return lines;
}

function jobId(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function createExecutingRun(database: DatabaseSync, count: number): string {
  const runId = '20000000-0000-4000-8000-000000000001';
  seedLegacyEvents(database, count);
  const rows = parseInventoryPayload(resultPayload(database, inventorySql(null)));
  let nextJob = 0;
  const inventory = buildBackfillRunPlan({
    runId,
    rows,
    now: NOW,
    runState: null,
    makeJobId: () => jobId(++nextJob),
  });
  applySqlUnit(database, inventory.statements.join('\n'));
  const state = parseRunStatePayload(resultPayload(database, runStateSql(runId)));
  const handoff = buildBackfillRunPlan({
    runId,
    rows: [],
    now: '2026-08-08T12:01:00.000Z',
    runState: state,
  });
  applySqlUnit(database, handoff.statements.join('\n'));
  return runId;
}

function candidateKey(candidate: DispatchClaimCandidate): string {
  return [
    candidate.runId,
    candidate.jobId,
    candidate.eventId,
    candidate.workflowInstanceId,
    candidate.dispatchGeneration,
  ].join(':');
}

function assertLaunchProtocol(artifact: LaunchArtifact): void {
  expect(artifact.steps.map((step) => step.order)).toEqual(
    Array.from({ length: artifact.steps.length }, (_, index) => index + 1),
  );
  expect(artifact.steps.slice(0, 2).map((step) => step.kind)).toEqual([
    'identity-check', 'identity-check',
  ]);
  const unitSteps = artifact.steps.slice(2);
  expect(unitSteps).toHaveLength(artifact.acceptedCandidates.length * 3);
  for (const [index, candidate] of artifact.acceptedCandidates.entries()) {
    const triple = unitSteps.slice(index * 3, index * 3 + 3);
    expect(triple.map((step) => step.kind)).toEqual(['trigger', 'confirm-read', 'receipt-read']);
    expect(triple.map((step) => step.jobId)).toEqual([
      candidate.jobId, candidate.jobId, candidate.jobId,
    ]);
    expect(triple[0]).toMatchObject({
      eventId: candidate.eventId,
      workflowInstanceId: candidate.workflowInstanceId,
      dispatchGeneration: candidate.dispatchGeneration,
    });
    const expectedParams = JSON.stringify({
      runId: candidate.runId,
      jobId: candidate.jobId,
      eventId: candidate.eventId,
    });
    expect(triple[0]?.command).toBe(
      `npx wrangler workflows trigger ${COVER_BACKFILL_WORKFLOW_NAME} '${expectedParams}'`
      + ` --id ${candidate.workflowInstanceId} --config ${WRANGLER_CONFIG_PATH}`,
    );
    expect(triple[0]?.command).not.toMatch(/--local|--remote/u);
  }
  expect(artifact.steps.filter((step) => step.kind === 'trigger').map((step) => step.jobId))
    .toEqual(artifact.acceptedCandidates.map((candidate) => candidate.jobId));
  const refused = new Set(artifact.refusedCandidates.map(candidateKey));
  for (const trigger of artifact.steps.filter((step) => step.kind === 'trigger')) {
    expect([...refused].some((key) => key.includes(String(trigger.jobId)))).toBe(false);
  }
}

function wranglerEntrypoint(): string {
  const packagePath = resolve(process.cwd(), 'node_modules/wrangler/package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    version?: string;
    bin?: { wrangler?: string };
  };
  expect(packageJson.version).toBe('4.113.0');
  expect(packageJson.bin?.wrangler).toBe('./bin/wrangler.js');
  return resolve(dirname(packagePath), packageJson.bin!.wrangler!);
}

function spawnWrangler(args: readonly string[], timeout = 60_000): WranglerResult {
  const result = spawnSync(process.execPath, [wranglerEntrypoint(), ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    timeout,
    windowsHide: true,
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runLocalD1File(
  persistTo: string,
  sqlFile: string,
  expected: 'success' | 'failure' = 'success',
): WranglerResult {
  const result = spawnWrangler([
    'd1', 'execute', 'candidary-core',
    '--local', '--persist-to', persistTo,
    '--config', 'wrangler.jsonc', '--json', '--file', sqlFile,
  ]);
  if (expected === 'success') {
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  } else {
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
  }
  return result;
}

function safeRemoveTemporaryDirectory(path: string): void {
  const resolvedTempRoot = resolve(tmpdir());
  const resolvedPath = resolve(path);
  if (!resolvedPath.startsWith(`${resolvedTempRoot}${sep}`)) {
    throw new Error(`Refusing to remove non-temporary path ${resolvedPath}.`);
  }
  rmSync(resolvedPath, { force: true, recursive: true });
}

function payloadRows(payload: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(payload)) throw new Error('Expected a Wrangler JSON result array.');
  return payload.flatMap((envelope) => {
    if (!envelope || typeof envelope !== 'object' || !('results' in envelope)) {
      throw new Error('Expected a Wrangler result envelope.');
    }
    const results = (envelope as { results: unknown }).results;
    if (!Array.isArray(results)) throw new Error('Expected result rows.');
    return results as Array<Record<string, unknown>>;
  });
}

afterEach(() => {
  for (const root of artifactRoots) rmSync(root, { force: true, recursive: true });
  artifactRoots.clear();
});

describe('the generated cover-backfill operator loop', () => {
  it('walks 101 migrated legacy events as literal 100/1/0 pages and replays no work after closure', () => {
    const database = migratedDatabase();
    const root = outputRoot('inventory');
    try {
      seedLegacyEvents(database, 101);

      const firstPayload = resultPayload(database, inventorySql(null));
      expect(parseInventoryPayload(firstPayload)).toHaveLength(100);
      expect(parseInventoryPayload(firstPayload).at(-1)?.id).toBe(eventId(100));
      const firstPayloadFile = savePayload(root, 'inventory-1.json', firstPayload);
      const firstPlanFile = `${root.relative}/execute-1.json`;
      invoke([
        'execute', '--payload-file', firstPayloadFile, '--plan-file', firstPlanFile,
        '--account-id', ACCOUNT, '--now', NOW,
      ]);
      const firstArtifact = readArtifact<ExecuteArtifact>(firstPlanFile);
      expect(firstArtifact).toMatchObject({
        cursor: eventId(100), inventoryExhausted: false, jobCount: 100,
      });
      expect(firstArtifact.steps.map(({ order, kind }) => ({ order, kind }))).toEqual([
        { order: 1, kind: 'identity-check' },
        { order: 2, kind: 'identity-check' },
        { order: 3, kind: 'ledger' },
        { order: 4, kind: 'run-state-read' },
      ]);
      const firstSql = sqlFor(firstPlanFile);
      applySqlUnit(database, firstSql);
      expect(database.prepare(`
        SELECT total_count, queued_count, applied_count, skipped_count,
               resolved_count, failed_count, needs_replacement_count
        FROM event_cover_backfill_runs WHERE id = ?
      `).get(firstArtifact.runId)).toEqual({
        total_count: 100,
        queued_count: 100,
        applied_count: 0,
        skipped_count: 0,
        resolved_count: 0,
        failed_count: 0,
        needs_replacement_count: 0,
      });

      const firstStatePayload = resultPayload(database, runStateSql(firstArtifact.runId));
      const firstState = parseRunStatePayload(firstStatePayload);
      const firstStateFile = savePayload(root, 'run-state-1.json', firstStatePayload);
      const secondPayload = resultPayload(database, inventorySql(firstState.cursor));
      expect(parseInventoryPayload(secondPayload)).toEqual([{
        id: eventId(101),
        cover_object_key: `events/${eventId(101)}/cover/legacy.jpg`,
        cover_revision: 0,
      }]);
      const secondPayloadFile = savePayload(root, 'inventory-2.json', secondPayload);
      const secondPlanFile = `${root.relative}/execute-2.json`;
      invoke([
        'execute', '--run-id', firstArtifact.runId, '--run-state-file', firstStateFile,
        '--payload-file', secondPayloadFile, '--plan-file', secondPlanFile,
        '--account-id', ACCOUNT, '--now', '2026-08-08T12:01:00.000Z',
      ]);
      const secondArtifact = readArtifact<ExecuteArtifact>(secondPlanFile);
      expect(secondArtifact).toMatchObject({
        runId: firstArtifact.runId,
        cursor: eventId(101),
        inventoryExhausted: false,
        jobCount: 1,
      });
      expect(secondArtifact.inventorySha256).not.toBe(firstArtifact.inventorySha256);
      const secondSql = sqlFor(secondPlanFile);
      applySqlUnit(database, secondSql);
      expect(database.prepare(`
        SELECT total_count, queued_count FROM event_cover_backfill_runs WHERE id = ?
      `).get(firstArtifact.runId)).toEqual({ total_count: 101, queued_count: 101 });

      const secondStatePayload = resultPayload(database, runStateSql(firstArtifact.runId));
      const secondState = parseRunStatePayload(secondStatePayload);
      const secondStateFile = savePayload(root, 'run-state-2.json', secondStatePayload);
      const exhaustedPayload = resultPayload(database, inventorySql(secondState.cursor));
      expect(parseInventoryPayload(exhaustedPayload)).toEqual([]);
      const exhaustedPayloadFile = savePayload(root, 'inventory-3.json', exhaustedPayload);
      const exhaustedPlanFile = `${root.relative}/execute-3.json`;
      invoke([
        'execute', '--run-id', firstArtifact.runId, '--run-state-file', secondStateFile,
        '--payload-file', exhaustedPayloadFile, '--plan-file', exhaustedPlanFile,
        '--account-id', ACCOUNT, '--now', '2026-08-08T12:02:00.000Z',
      ]);
      const exhaustedArtifact = readArtifact<ExecuteArtifact>(exhaustedPlanFile);
      expect(exhaustedArtifact).toMatchObject({
        runId: firstArtifact.runId,
        cursor: eventId(101),
        inventoryExhausted: true,
        jobCount: 0,
        inventorySha256: secondArtifact.inventorySha256,
      });
      const exhaustedSql = sqlFor(exhaustedPlanFile);
      applySqlUnit(database, exhaustedSql);

      const closedRun = database.prepare(`
        SELECT mode, status, cursor, total_count, queued_count, applied_count,
               skipped_count, resolved_count, failed_count, needs_replacement_count
        FROM event_cover_backfill_runs WHERE id = ?
      `).get(firstArtifact.runId);
      expect(closedRun).toEqual({
        mode: 'execute',
        status: 'executing',
        cursor: eventId(101),
        total_count: 101,
        queued_count: 101,
        applied_count: 0,
        skipped_count: 0,
        resolved_count: 0,
        failed_count: 0,
        needs_replacement_count: 0,
      });
      const identities = database.prepare(`
        SELECT id, event_id, workflow_instance_id
        FROM event_cover_backfill_jobs WHERE run_id = ? ORDER BY event_id
      `).all(firstArtifact.runId);
      expect(identities).toHaveLength(101);
      expect(new Set(identities.map((entry) => entry['id']))).toHaveLength(101);
      expect(new Set(identities.map((entry) => entry['workflow_instance_id']))).toHaveLength(101);

      applySqlUnit(database, firstSql);
      applySqlUnit(database, secondSql);
      applySqlUnit(database, exhaustedSql);
      expect(database.prepare(`
        SELECT id, event_id, workflow_instance_id
        FROM event_cover_backfill_jobs WHERE run_id = ? ORDER BY event_id
      `).all(firstArtifact.runId)).toEqual(identities);
      expect(database.prepare(`
        SELECT mode, status, cursor, total_count, queued_count, applied_count,
               skipped_count, resolved_count, failed_count, needs_replacement_count
        FROM event_cover_backfill_runs WHERE id = ?
      `).get(firstArtifact.runId)).toEqual(closedRun);
    } finally {
      database.close();
    }
  });

  it('claims and launches more than 25 jobs in exact bounded waves and confirms idempotently', () => {
    const database = migratedDatabase();
    const root = outputRoot('dispatch');
    try {
      const runId = createExecutingRun(database, 51);
      const firstRead = resultPayload(database, dispatchSql(runId));
      const firstObserved = parseDispatchPayload(firstRead);
      expect(firstObserved.rows).toHaveLength(25);
      expect(firstObserved.rows.every((row) => (
        row.dispatchState === 'pending'
        && row.dispatchGeneration === 0
        && row.fenceState === null
        && row.fenceGeneration === null
      ))).toBe(true);
      expect(firstObserved).toMatchObject({
        nonterminal: 0,
        activeRuns: 0,
        minuteClaims: 0,
        retryable: 0,
        latestClaimAt: null,
      });

      const firstReadFile = savePayload(root, 'dispatch-read-1.json', firstRead);
      const firstClaimFile = `${root.relative}/dispatch-1.json`;
      invoke([
        'dispatch', '--run-id', runId, '--payload-file', firstReadFile,
        '--plan-file', firstClaimFile, '--account-id', ACCOUNT, '--now', NOW,
      ]);
      const firstClaim = readArtifact<DispatchArtifact>(firstClaimFile);
      expect(firstClaim.candidates).toHaveLength(25);
      expect(firstClaim.candidates.map((candidate) => candidate.dispatchGeneration))
        .toEqual(Array.from({ length: 25 }, () => 1));
      expect(firstClaim.steps.map(({ order, kind }) => ({ order, kind }))).toEqual([
        { order: 1, kind: 'identity-check' },
        { order: 2, kind: 'identity-check' },
        { order: 3, kind: 'claim' },
        { order: 4, kind: 'claimed-read' },
      ]);
      expect(JSON.stringify(firstClaim)).not.toContain('wrangler workflows trigger');
      applySqlUnit(database, sqlFor(firstClaimFile));
      expect(database.prepare(`
        SELECT count(*) AS value FROM event_cover_backfill_jobs
        WHERE run_id = ? AND dispatch_state = 'creating' AND dispatch_generation = 1
      `).get(runId)).toEqual({ value: 25 });
      expect(database.prepare(`
        SELECT count(*) AS value FROM event_cover_workflow_fences
        WHERE workflow_binding = 'COVER_BACKFILL_WORKFLOW'
          AND state = 'open' AND dispatch_generation = 1
      `).get()).toEqual({ value: 25 });

      const firstClaimedPayload = resultPayload(
        database,
        claimedDispatchSql(runId, firstObserved.rows),
      );
      const firstClaimed = parseClaimedDispatchPayload(firstClaimedPayload);
      expect(firstClaimed).toHaveLength(25);
      expect(firstClaimed.every((result) => result.accepted)).toBe(true);
      expect(firstClaimed.map((result) => candidateKey(result.candidate)))
        .toEqual(firstClaim.candidates.map(candidateKey));
      const firstClaimedFile = savePayload(root, 'dispatch-1.claimed.json', firstClaimedPayload);
      const firstLaunchFile = `${root.relative}/launch-1.json`;
      invoke([
        'launch', '--run-id', runId, '--claim-file', firstClaimFile,
        '--payload-file', firstClaimedFile, '--plan-file', firstLaunchFile,
        '--account-id', ACCOUNT, '--now', firstClaim.notBefore,
      ]);
      const firstLaunch = readArtifact<LaunchArtifact>(firstLaunchFile);
      expect(firstLaunch.acceptedCandidates.map(candidateKey))
        .toEqual(firstClaim.candidates.map(candidateKey));
      expect(firstLaunch.refusedCandidates).toEqual([]);
      assertLaunchProtocol(firstLaunch);

      const confirmationCandidate = firstLaunch.acceptedCandidates[0]!;
      const confirmationRead = resultPayload(database, confirmSql({
        runId,
        jobId: confirmationCandidate.jobId,
        eventId: confirmationCandidate.eventId,
      }));
      const confirmationRows = parseConfirmPayload(confirmationRead);
      expect(confirmationRows).toHaveLength(1);
      expect(confirmationRows[0]).toMatchObject({
        dispatchState: 'creating',
        dispatchGeneration: 1,
        fenceState: 'open',
        fenceGeneration: 1,
      });
      const confirmationReadFile = savePayload(root, 'confirm-read-1.json', confirmationRead);
      const confirmationFile = `${root.relative}/confirm-1.json`;
      invoke([
        'confirm', '--run-id', runId,
        '--job-id', confirmationCandidate.jobId,
        '--event-id', confirmationCandidate.eventId,
        '--generation', '1', '--payload-file', confirmationReadFile,
        '--plan-file', confirmationFile, '--account-id', ACCOUNT,
        '--now', firstClaim.notBefore,
      ]);
      const confirmation = readArtifact<ConfirmationArtifact>(confirmationFile);
      expect(confirmation).toMatchObject({
        runId,
        jobId: confirmationCandidate.jobId,
        eventId: confirmationCandidate.eventId,
        generation: 1,
        outcome: 'confirm',
      });
      expect(confirmation.steps.map(({ order, kind }) => ({ order, kind }))).toEqual([
        { order: 1, kind: 'identity-check' },
        { order: 2, kind: 'identity-check' },
        { order: 3, kind: 'apply' },
        { order: 4, kind: 'receipt-read' },
      ]);
      expect(JSON.stringify(confirmation)).not.toContain('wrangler workflows trigger');
      const confirmationSql = sqlFor(confirmationFile);
      applySqlUnit(database, confirmationSql);
      expect(database.prepare(`
        SELECT dispatch_state, dispatch_generation FROM event_cover_backfill_jobs WHERE id = ?
      `).get(confirmationCandidate.jobId)).toEqual({
        dispatch_state: 'confirmed', dispatch_generation: 1,
      });

      const replayRead = resultPayload(database, confirmSql({
        runId,
        jobId: confirmationCandidate.jobId,
        eventId: confirmationCandidate.eventId,
      }));
      const replayPlan = evaluateConfirmation(parseConfirmPayload(replayRead), {
        runId,
        jobId: confirmationCandidate.jobId,
        eventId: confirmationCandidate.eventId,
        generation: 1,
        now: firstClaim.notBefore,
      });
      expect(replayPlan).toMatchObject({ outcome: 'confirm' });
      expect(replayPlan.reasons.join(' ')).toMatch(/replay/u);
      const beforeReplay = database.prepare('SELECT total_changes() AS value').get()!['value'];
      applySqlUnit(database, replayPlan.statements.join('\n'));
      const afterReplay = database.prepare('SELECT total_changes() AS value').get()!['value'];
      expect(afterReplay).toBe(beforeReplay);

      const limitedRead = resultPayload(database, dispatchSql(runId));
      const limitedObserved = parseDispatchPayload(limitedRead);
      expect(limitedObserved).toMatchObject({ nonterminal: 25, minuteClaims: 25 });
      expect(limitedObserved.rows).toHaveLength(25);
      const limitedFile = savePayload(root, 'dispatch-limited.json', limitedRead);
      const refusedByCapacityFile = `${root.relative}/dispatch-limited-plan.json`;
      const limitedLines = invoke([
        'dispatch', '--run-id', runId, '--payload-file', limitedFile,
        '--plan-file', refusedByCapacityFile, '--account-id', ACCOUNT,
        '--now', firstClaim.notBefore,
      ]);
      const exactNotBefore = new Date(
        Date.parse(limitedObserved.latestClaimAt!) + 60_000,
      ).toISOString();
      expect(limitedLines.join('\n')).toContain(`0 would be claimed, not before ${exactNotBefore}`);
      expect(limitedLines.join('\n')).toContain('(limited by minute)');
      expect(() => readFileSync(resolve(process.cwd(), refusedByCapacityFile), 'utf8')).toThrow();

      const settle = database.prepare(`
        UPDATE event_cover_backfill_jobs
        SET dispatch_state = 'confirmed', status = 'applied', terminal_at = ?, updated_at = ?
        WHERE id = ? AND run_id = ?
      `);
      for (const candidate of firstClaim.candidates) {
        settle.run('2026-08-08T12:02:00.000Z', '2026-08-08T12:02:00.000Z', candidate.jobId, runId);
      }
      database.prepare(`
        UPDATE event_cover_workflow_fences SET updated_at = '2000-01-01T00:00:00.000Z'
        WHERE workflow_binding = 'COVER_BACKFILL_WORKFLOW'
      `).run();

      const secondRead = resultPayload(database, dispatchSql(runId));
      const secondObserved = parseDispatchPayload(secondRead);
      expect(secondObserved).toMatchObject({ nonterminal: 0, minuteClaims: 0 });
      expect(secondObserved.rows).toHaveLength(25);
      const firstWaveJobIds = new Set(
        firstClaim.candidates.map((candidate) => candidate.jobId),
      );
      expect(secondObserved.rows.some((row) => firstWaveJobIds.has(row.jobId))).toBe(false);
      const secondReadFile = savePayload(root, 'dispatch-read-2.json', secondRead);
      const secondClaimFile = `${root.relative}/dispatch-2.json`;
      invoke([
        'dispatch', '--run-id', runId, '--payload-file', secondReadFile,
        '--plan-file', secondClaimFile, '--account-id', ACCOUNT,
        '--now', '2026-08-08T12:03:00.000Z',
      ]);
      const secondClaim = readArtifact<DispatchArtifact>(secondClaimFile);
      expect(secondClaim.candidates).toHaveLength(25);
      applySqlUnit(database, sqlFor(secondClaimFile));
      const secondClaimedPayload = resultPayload(
        database,
        claimedDispatchSql(runId, secondObserved.rows),
      );
      const secondClaimed = parseClaimedDispatchPayload(secondClaimedPayload);
      expect(secondClaimed.every((result) => result.accepted)).toBe(true);
      const secondClaimedFile = savePayload(root, 'dispatch-2.claimed.json', secondClaimedPayload);
      const secondLaunchFile = `${root.relative}/launch-2.json`;
      invoke([
        'launch', '--run-id', runId, '--claim-file', secondClaimFile,
        '--payload-file', secondClaimedFile, '--plan-file', secondLaunchFile,
        '--account-id', ACCOUNT, '--now', secondClaim.notBefore,
      ]);
      const secondLaunch = readArtifact<LaunchArtifact>(secondLaunchFile);
      assertLaunchProtocol(secondLaunch);
      expect(secondLaunch.acceptedCandidates).toHaveLength(25);
      expect(firstLaunch.acceptedCandidates.length + secondLaunch.acceptedCandidates.length)
        .toBe(50);

      database.prepare('UPDATE events SET cover_object_key = NULL WHERE deleted_at IS NULL').run();
      const proofPayload = resultPayload(database, proofSql());
      const proofFile = savePayload(root, 'proof.json', proofPayload);
      const proofLines: string[] = [];
      expect(runCli(['verify', '--payload-file', proofFile], {}, (line) => proofLines.push(line)))
        .toBe(0);
      expect(proofLines.join('\n')).toContain('"proven": true');
      expect(proofLines.join('\n')).not.toMatch(/UPDATE|wrangler workflows/u);
    } finally {
      database.close();
    }
  });

  it('dry-walks the generated sequence through pinned Wrangler local D1 and observes rollback', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'candidary-cover-backfill-'));
    const persistTo = join(temporaryRoot, 'state');
    mkdirSync(persistTo, { recursive: true });
    let sqlSequence = 0;
    const sqlPath = (label: string, sql: string): string => {
      const path = join(
        temporaryRoot,
        `${String(++sqlSequence).padStart(2, '0')}-${label}.sql`,
      );
      writeFileSync(path, `${sql.trim()}\n`, 'utf8');
      return path;
    };
    const executeSql = (
      label: string,
      sql: string,
      expected: 'success' | 'failure' = 'success',
    ): WranglerResult => runLocalD1File(persistTo, sqlPath(label, sql), expected);
    const readSql = (label: string, sql: string): unknown => (
      JSON.parse(executeSql(label, sql).stdout) as unknown
    );
    const saveJson = (name: string, payload: unknown): string => {
      const path = join(temporaryRoot, name);
      writeFileSync(path, `${JSON.stringify(payload)}\n`, 'utf8');
      return path;
    };

    try {
      const version = spawnWrangler(['--version']);
      expect(version.status, `${version.stdout}\n${version.stderr}`).toBe(0);
      expect(version.stdout.trim()).toBe('4.113.0');

      const migrationRoot = resolve(process.cwd(), 'migrations');
      const migrations = readdirSync(migrationRoot)
        .filter((entry) => entry.endsWith('.sql'))
        .sort();
      expect(migrations).toEqual([
        '0001_core.sql',
        '0002_wedding_photo_drop.sql',
        '0003_partitioned_exports.sql',
        '0004_manager_media_pagination.sql',
        '0005_media_stored_at.sql',
        '0006_host_accounts.sql',
        '0007_event_theme.sql',
        '0008_event_rsvp.sql',
        '0009_rsvp_roster_batches.sql',
        '0010_event_start.sql',
        '0011_release_certifications.sql',
        '0012_event_cover_storage.sql',
        '0013_guest_message_hardening.sql',
      ]);
      for (const migration of migrations) {
        runLocalD1File(persistTo, resolve(migrationRoot, migration));
      }

      const event = '30000000-0000-4000-8000-000000000001';
      executeSql('seed', `
        INSERT INTO events (
          id, slug, name, event_date, welcome_message, cover_object_key,
          guest_access_expires_at, management_access_expires_at, purge_after, created_at
        ) VALUES (
          '${event}', 'wrangler-operator-loop', 'Wrangler operator loop',
          '2026-08-08', 'Welcome', 'events/${event}/cover/legacy.jpg',
          '${NOW}', '${NOW}', '${NOW}', '${NOW}'
        );
      `);

      const inventoryPayload = readSql('inventory-read', inventorySql(null));
      expect(parseInventoryPayload(inventoryPayload)).toEqual([{
        id: event,
        cover_object_key: `events/${event}/cover/legacy.jpg`,
        cover_revision: 0,
      }]);
      const inventoryPayloadFile = saveJson('inventory.json', inventoryPayload);
      const pagePlanFile = join(temporaryRoot, 'execute-page.json');
      invoke([
        'execute', '--payload-file', inventoryPayloadFile, '--plan-file', pagePlanFile,
        '--account-id', ACCOUNT, '--now', NOW,
      ]);
      const pageArtifact = readArtifact<ExecuteArtifact>(pagePlanFile);
      expect(pageArtifact).toMatchObject({
        cursor: event,
        inventoryExhausted: false,
        jobCount: 1,
      });
      expect(pageArtifact.steps.map((step) => step.kind)).toEqual([
        'identity-check', 'identity-check', 'ledger', 'run-state-read',
      ]);
      const pageSql = readFileSync(pagePlanFile.replace(/\.json$/u, '.sql'), 'utf8');
      runLocalD1File(persistTo, pagePlanFile.replace(/\.json$/u, '.sql'));

      const firstStatePayload = readSql('run-state-1', runStateSql(pageArtifact.runId));
      const firstState = parseRunStatePayload(firstStatePayload);
      expect(firstState).toMatchObject({
        runId: pageArtifact.runId,
        mode: 'inventory',
        status: 'inventorying',
        cursor: event,
        inventorySha256: pageArtifact.inventorySha256,
      });
      const firstStateFile = saveJson('run-state-1.json', firstStatePayload);
      const emptyPayload = readSql('inventory-empty-read', inventorySql(firstState.cursor));
      expect(parseInventoryPayload(emptyPayload)).toEqual([]);
      const emptyPayloadFile = saveJson('inventory-empty.json', emptyPayload);
      const handoffPlanFile = join(temporaryRoot, 'execute-handoff.json');
      invoke([
        'execute', '--run-id', pageArtifact.runId, '--run-state-file', firstStateFile,
        '--payload-file', emptyPayloadFile, '--plan-file', handoffPlanFile,
        '--account-id', ACCOUNT, '--now', '2026-08-08T12:01:00.000Z',
      ]);
      const handoffArtifact = readArtifact<ExecuteArtifact>(handoffPlanFile);
      expect(handoffArtifact).toMatchObject({
        runId: pageArtifact.runId,
        cursor: event,
        inventorySha256: pageArtifact.inventorySha256,
        inventoryExhausted: true,
        jobCount: 0,
      });
      runLocalD1File(persistTo, handoffPlanFile.replace(/\.json$/u, '.sql'));

      const closedSnapshotSql = `
        SELECT r.mode, r.status, r.cursor, r.inventory_sha256,
               r.total_count, r.queued_count,
               j.id AS job_id, j.workflow_instance_id,
               j.dispatch_state, j.dispatch_generation
        FROM event_cover_backfill_runs r
        JOIN event_cover_backfill_jobs j ON j.run_id = r.id
        WHERE r.id = '${pageArtifact.runId}';
      `;
      const beforeLateReplay = payloadRows(readSql('closed-before-replay', closedSnapshotSql));
      expect(beforeLateReplay).toEqual([expect.objectContaining({
        mode: 'execute',
        status: 'executing',
        cursor: event,
        inventory_sha256: pageArtifact.inventorySha256,
        total_count: 1,
        queued_count: 1,
        dispatch_state: 'pending',
        dispatch_generation: 0,
      })]);
      executeSql('late-page-replay', pageSql);
      runLocalD1File(persistTo, handoffPlanFile.replace(/\.json$/u, '.sql'));
      const afterLateReplay = payloadRows(readSql('closed-after-replay', closedSnapshotSql));
      expect(afterLateReplay).toEqual(beforeLateReplay);

      const dispatchPayload = readSql('dispatch-read', dispatchSql(pageArtifact.runId));
      const observed = parseDispatchPayload(dispatchPayload);
      expect(observed.rows).toHaveLength(1);
      expect(observed.rows[0]).toMatchObject({
        dispatchState: 'pending',
        dispatchGeneration: 0,
        fenceState: null,
        fenceGeneration: null,
      });
      const dispatchPayloadFile = saveJson('dispatch-read.json', dispatchPayload);
      const claimPlanFile = join(temporaryRoot, 'dispatch-claim.json');
      invoke([
        'dispatch', '--run-id', pageArtifact.runId,
        '--payload-file', dispatchPayloadFile, '--plan-file', claimPlanFile,
        '--account-id', ACCOUNT, '--now', '2026-08-08T12:02:00.000Z',
      ]);
      const claimArtifact = readArtifact<DispatchArtifact>(claimPlanFile);
      expect(claimArtifact.steps.map((step) => step.kind)).toEqual([
        'identity-check', 'identity-check', 'claim', 'claimed-read',
      ]);
      expect(JSON.stringify(claimArtifact)).not.toContain('wrangler workflows trigger');
      const candidate = claimArtifact.candidates[0]!;
      const claimSql = readFileSync(claimPlanFile.replace(/\.json$/u, '.sql'), 'utf8');
      const failedClaim = executeSql(
        'claim-check-failure',
        `${claimSql}\nUPDATE event_cover_backfill_jobs SET retryable = 2 WHERE id = '${candidate.jobId}';`,
        'failure',
      );
      expect(`${failedClaim.stdout}\n${failedClaim.stderr}`).toMatch(/CHECK constraint failed/iu);

      const rolledBackJob = payloadRows(readSql('rollback-job-proof', `
        SELECT dispatch_state, dispatch_generation
        FROM event_cover_backfill_jobs WHERE id = '${candidate.jobId}';
      `));
      expect(rolledBackJob).toEqual([{ dispatch_state: 'pending', dispatch_generation: 0 }]);
      const rolledBackFence = payloadRows(readSql('rollback-fence-proof', `
        SELECT count(*) AS value FROM event_cover_workflow_fences
        WHERE workflow_binding = 'COVER_BACKFILL_WORKFLOW'
          AND workflow_instance_id = '${candidate.workflowInstanceId}';
      `));
      expect(rolledBackFence).toEqual([{ value: 0 }]);

      runLocalD1File(persistTo, claimPlanFile.replace(/\.json$/u, '.sql'));
      const claimedPayload = readSql(
        'claimed-read',
        claimedDispatchSql(pageArtifact.runId, observed.rows),
      );
      const claimed = parseClaimedDispatchPayload(claimedPayload);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        accepted: true,
        candidate,
        row: expect.objectContaining({
          dispatchState: 'creating',
          dispatchGeneration: 1,
          fenceState: 'open',
          fenceGeneration: 1,
        }),
      });
      const claimedPayloadFile = saveJson('claimed-read.json', claimedPayload);
      const launchPlanFile = join(temporaryRoot, 'launch.json');
      invoke([
        'launch', '--run-id', pageArtifact.runId, '--claim-file', claimPlanFile,
        '--payload-file', claimedPayloadFile, '--plan-file', launchPlanFile,
        '--account-id', ACCOUNT, '--now', claimArtifact.notBefore,
      ]);
      const launchArtifact = readArtifact<LaunchArtifact>(launchPlanFile);
      expect(launchArtifact.acceptedCandidates).toEqual([candidate]);
      expect(launchArtifact.refusedCandidates).toEqual([]);
      assertLaunchProtocol(launchArtifact);

      // The trigger is deliberately never executed. Only D1 files pass to the
      // subprocess; the production Workflow command remains inspected text.
      const confirmReadPayload = readSql('confirm-read', confirmSql({
        runId: pageArtifact.runId,
        jobId: candidate.jobId,
        eventId: candidate.eventId,
      }));
      expect(parseConfirmPayload(confirmReadPayload)).toEqual([
        expect.objectContaining({
          dispatchState: 'creating',
          dispatchGeneration: 1,
          fenceState: 'open',
          fenceGeneration: 1,
        }),
      ]);
      const confirmReadFile = saveJson('confirm-read.json', confirmReadPayload);
      const confirmPlanFile = join(temporaryRoot, 'confirm.json');
      invoke([
        'confirm', '--run-id', pageArtifact.runId,
        '--job-id', candidate.jobId, '--event-id', candidate.eventId,
        '--generation', '1', '--payload-file', confirmReadFile,
        '--plan-file', confirmPlanFile, '--account-id', ACCOUNT,
        '--now', claimArtifact.notBefore,
      ]);
      const confirmArtifact = readArtifact<ConfirmationArtifact>(confirmPlanFile);
      expect(confirmArtifact.steps.map((step) => step.kind)).toEqual([
        'identity-check', 'identity-check', 'apply', 'receipt-read',
      ]);
      expect(JSON.stringify(confirmArtifact)).not.toContain('wrangler workflows trigger');
      runLocalD1File(persistTo, confirmPlanFile.replace(/\.json$/u, '.sql'));
      const receipt = parseConfirmPayload(readSql('receipt-read', confirmSql({
        runId: pageArtifact.runId,
        jobId: candidate.jobId,
        eventId: candidate.eventId,
      })));
      expect(receipt).toEqual([expect.objectContaining({
        dispatchState: 'confirmed',
        dispatchGeneration: 1,
        fenceState: 'open',
        fenceGeneration: 1,
      })]);
      runLocalD1File(persistTo, confirmPlanFile.replace(/\.json$/u, '.sql'));
      const replayReceipt = parseConfirmPayload(readSql('receipt-replay', confirmSql({
        runId: pageArtifact.runId,
        jobId: candidate.jobId,
        eventId: candidate.eventId,
      })));
      expect(replayReceipt).toEqual(receipt);

      executeSql('settle-for-proof', `
        UPDATE event_cover_backfill_jobs
        SET status = 'applied', terminal_at = '${NOW}', updated_at = '${NOW}'
        WHERE id = '${candidate.jobId}';
        UPDATE events SET cover_object_key = NULL WHERE id = '${event}';
      `);
      const proofPayload = readSql('verification-display', proofSql());
      expect(payloadRows(proofPayload)).toEqual([
        { name: 'legacyRows', value: 0 },
        { name: 'blockingJobs', value: 0 },
        { name: 'incompleteActiveSets', value: 0 },
        { name: 'uploadsWithoutActiveSet', value: 0 },
      ]);
      const proofPayloadFile = saveJson('verification-display.json', proofPayload);
      const display: string[] = [];
      expect(runCli(['verify', '--payload-file', proofPayloadFile], {}, (line) => display.push(line)))
        .toBe(0);
      expect(display.join('\n')).toContain('"proven": true');
      expect(display.join('\n')).not.toMatch(/UPDATE|wrangler workflows/u);
    } finally {
      safeRemoveTemporaryDirectory(temporaryRoot);
    }
  }, 120_000);

  it('keeps a stale refused claim pending and emits no trigger artifact on replay', () => {
    const database = migratedDatabase();
    const root = outputRoot('refused');
    try {
      const runId = createExecutingRun(database, 1);
      const dispatchRead = resultPayload(database, dispatchSql(runId));
      const observed = parseDispatchPayload(dispatchRead);
      expect(observed.rows).toHaveLength(1);
      const dispatchReadFile = savePayload(root, 'dispatch.json', dispatchRead);
      const claimFile = `${root.relative}/claim.json`;
      invoke([
        'dispatch', '--run-id', runId, '--payload-file', dispatchReadFile,
        '--plan-file', claimFile, '--account-id', ACCOUNT, '--now', NOW,
      ]);
      const claim = readArtifact<DispatchArtifact>(claimFile);
      const candidate = claim.candidates[0]!;
      database.prepare('UPDATE events SET deleted_at = ? WHERE id = ?').run(NOW, candidate.eventId);
      const claimSql = sqlFor(claimFile);
      applySqlUnit(database, claimSql);
      applySqlUnit(database, claimSql);
      expect(database.prepare(`
        SELECT dispatch_state, dispatch_generation FROM event_cover_backfill_jobs WHERE id = ?
      `).get(candidate.jobId)).toEqual({ dispatch_state: 'pending', dispatch_generation: 0 });
      expect(database.prepare(`
        SELECT count(*) AS value FROM event_cover_workflow_fences
        WHERE workflow_binding = 'COVER_BACKFILL_WORKFLOW'
          AND workflow_instance_id = ?
      `).get(candidate.workflowInstanceId)).toEqual({ value: 0 });

      const claimedPayload = resultPayload(database, claimedDispatchSql(runId, observed.rows));
      const claimed = parseClaimedDispatchPayload(claimedPayload);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ accepted: false, row: expect.any(Object) });
      const claimedFile = savePayload(root, 'claimed.json', claimedPayload);
      const launchFile = `${root.relative}/launch.json`;
      const lines = invoke([
        'launch', '--run-id', runId, '--claim-file', claimFile,
        '--payload-file', claimedFile, '--plan-file', launchFile,
        '--account-id', ACCOUNT, '--now', claim.notBefore,
      ]);
      expect(lines.join('\n')).toContain('0 committed claims accepted; 1 explicitly refused.');
      expect(lines.join('\n')).not.toContain('wrangler workflows trigger');
      expect(() => readFileSync(resolve(process.cwd(), launchFile), 'utf8')).toThrow();
    } finally {
      database.close();
    }
  });
});

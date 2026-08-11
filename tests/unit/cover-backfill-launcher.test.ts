// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_COVER_BACKFILL_CREATE_BATCH,
  MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
  MAX_COVER_BACKFILL_IN_FLIGHT,
  MAX_COVER_BACKFILL_PAGE_SIZE,
} from '../../shared/constants';
import {
  blockCoverBackfillDispatchSql,
  confirmCoverBackfillDispatchSql,
} from '../../shared/cover-dispatch';
import {
  ZERO_LEGACY_PROOF_NAMES,
  zeroLegacyProofRowsSql,
} from '../../shared/cover-backfill-proof';
import { COVER_PIPELINE_VERSIONS } from '../../shared/event-cover';
import {
  COVER_BACKFILL_BINDING,
  COVER_BACKFILL_DATABASE_ID,
  COVER_BACKFILL_DATABASE_NAME,
  COVER_BACKFILL_DEPENDENCY_VERSIONS,
  COVER_BACKFILL_JOB_STATUSES,
  COVER_BACKFILL_RUN_MODES,
  COVER_BACKFILL_WORKER_NAME,
  COVER_BACKFILL_WORKFLOW_NAME,
  COVER_DISPATCH_STATES,
  COVER_FENCE_STATES,
  LIVE_DISPATCH_STATES,
  WRANGLER_CONFIG_PATH,
  backfillInstanceId,
  buildBackfillRunPlan,
  buildDispatchBatch,
  buildLaunchPlan,
  claimedDispatchSql,
  confirmSql,
  d1FileCommand,
  d1ReadCommands,
  dispatchSql,
  evaluateConfirmation,
  evaluateZeroLegacyProof,
  fingerprintKey,
  identityCheckCommands,
  inventoryDigest,
  inventorySql,
  parseConfirmPayload,
  parseClaimedDispatchPayload,
  parseCountPayload,
  parseCoverBackfillArgs,
  parseDispatchPayload,
  parseInventoryPayload,
  parseRunStatePayload,
  proofSql,
  rollingInventoryDigest,
  runCli,
  runStateSql,
  verificationRunStatement,
  type DurableDispatchRow,
  type InventoryRow,
  type RunStateRow,
} from '../../scripts/cover-backfill';

const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '99999999-9999-4999-8999-999999999999';
const JOB = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const OTHER_EVENT = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-08-05T10:00:00.000Z';
const PHASE_2_MIGRATION = '0013_guest_message_hardening.sql';

function phase2MigrationNames(migrationRoot: string): string[] {
  const migrations = readdirSync(migrationRoot)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
  const boundary = migrations.indexOf(PHASE_2_MIGRATION);
  expect(boundary).toBe(12);
  return migrations.slice(0, boundary + 1);
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  const migrationRoot = resolve(process.cwd(), 'migrations');
  // Backfill operates on the compatibility schema. Installing Phase 3 here
  // correctly prevents the legacy fixtures this harness is meant to exercise.
  for (const name of phase2MigrationNames(migrationRoot)) {
    database.exec(readFileSync(resolve(migrationRoot, name), 'utf8'));
  }
  return database;
}

function seedDispatchCandidate(
  database: DatabaseSync,
  input: {
    runMode?: 'inventory' | 'execute' | 'verify';
    runStatus?: 'inventorying' | 'executing' | 'verified' | 'failed';
  } = {},
): DurableDispatchRow {
  database.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message, cover_object_key,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, 'task-3-event', 'Task 3', '2026-08-08', 'Welcome',
      'events/task-3/cover/legacy.jpg', ?, ?, ?, ?)
  `).run(EVENT, NOW, NOW, NOW, NOW);
  database.prepare(`
    INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(RUN, input.runMode ?? 'execute', input.runStatus ?? 'executing', NOW, NOW);
  const candidate = dispatchRow(1, {
    jobId: JOB,
    eventId: EVENT,
    workflowInstanceId: `cb1-${'1'.repeat(48)}`,
  });
  database.prepare(`
    INSERT INTO event_cover_backfill_jobs (
      id, run_id, event_id, expected_revision, legacy_key_fingerprint,
      workflow_instance_id, dispatch_state, dispatch_generation, status,
      dependency_versions_json, created_at, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, 'pending', 0, 'queued', '{}', ?, ?)
  `).run(
    candidate.jobId,
    candidate.runId,
    candidate.eventId,
    'a'.repeat(64),
    candidate.workflowInstanceId,
    NOW,
    NOW,
  );
  return candidate;
}

function dispatchRows(database: DatabaseSync, runId = RUN): unknown[] {
  const sql = dispatchSql(runId);
  return database.prepare(sql.slice(0, sql.indexOf(';') + 1)).all();
}

function fillInFlightCapacity(database: DatabaseSync): void {
  const insertEvent = database.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message, cover_object_key,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Capacity', '2026-08-08', 'Welcome', ?, ?, ?, ?, ?)
  `);
  const insertJob = database.prepare(`
    INSERT INTO event_cover_backfill_jobs (
      id, run_id, event_id, expected_revision, legacy_key_fingerprint,
      workflow_instance_id, dispatch_state, dispatch_generation, status,
      dependency_versions_json, created_at, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, 'creating', 1, 'queued', '{}', ?, ?)
  `);
  for (let index = 0; index < MAX_COVER_BACKFILL_IN_FLIGHT; index += 1) {
    const suffix = `${index + 100}`.padStart(12, '0');
    const eventId = `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
    const jobId = `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
    const instanceId = `cb1-${`${index + 500}`.padStart(48, '0')}`;
    insertEvent.run(
      eventId,
      `capacity-${index}`,
      `events/${eventId}/cover/legacy.jpg`,
      NOW,
      NOW,
      NOW,
      NOW,
    );
    insertJob.run(jobId, RUN, eventId, 'b'.repeat(64), instanceId, NOW, NOW);
  }
}

it('promises immediate access revocation and scheduled physical cleanup in Manager', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/pages/ManagerPage.tsx'), 'utf8');
  expect(source).toContain('revoke access immediately and schedule every private file for permanent deletion');
  expect(source).not.toContain('permanently remove every file');
});

const row = (id: string, key: string, revision = 0): InventoryRow => ({
  id,
  cover_object_key: key,
  cover_revision: revision,
});

const envelope = (rows: readonly unknown[]) => [{ results: rows, success: true }];
const envelopes = (...sets: unknown[][]) => sets.map((rows) => ({ results: rows, success: true }));

const dispatchRow = (index: number, overrides: Partial<DurableDispatchRow> = {}): DurableDispatchRow => ({
  runId: RUN,
  jobId: `${index}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
  eventId: `${index}`.padStart(8, '1') + '-1111-4111-8111-111111111111',
  workflowInstanceId: `cb1-${`${index}`.padStart(48, '0')}`,
  dispatchState: 'pending',
  dispatchGeneration: 0,
  status: 'queued',
  fenceState: null,
  fenceGeneration: null,
  ...overrides,
});

/** A wire row as `wrangler d1 execute --json` would return it for `dispatchSql`. */
const dispatchWireRow = (source: DurableDispatchRow) => ({
  kind: 'dispatchable',
  run_id: source.runId,
  job_id: source.jobId,
  event_id: source.eventId,
  workflow_instance_id: source.workflowInstanceId,
  dispatch_state: source.dispatchState,
  dispatch_generation: source.dispatchGeneration,
  status: source.status,
  fence_state: source.fenceState,
  fence_generation: source.fenceGeneration,
});

const counterRows = (values: {
  nonterminal?: number;
  activeRuns?: number;
  minuteClaims?: number;
  retryable?: number;
  latestClaimAt?: string | null;
} = {}) => [
  { kind: 'nonterminal', value: values.nonterminal ?? 0, at: null },
  { kind: 'activeRuns', value: values.activeRuns ?? 0, at: null },
  { kind: 'minuteClaims', value: values.minuteClaims ?? 0, at: null },
  { kind: 'retryable', value: values.retryable ?? 0, at: null },
  { kind: 'latestClaimAt', value: 0, at: values.latestClaimAt ?? null },
];

const dispatchPayload = (
  rows: readonly DurableDispatchRow[],
  values: Parameters<typeof counterRows>[0] = {},
) => envelopes(rows.map(dispatchWireRow), counterRows(values));

const claimCandidate = (source: DurableDispatchRow) => ({
  runId: source.runId,
  jobId: source.jobId,
  eventId: source.eventId,
  workflowInstanceId: source.workflowInstanceId,
  dispatchGeneration: source.dispatchGeneration + 1,
});

const claimedWireRow = (
  source: DurableDispatchRow,
  accepted: boolean,
  overrides: Record<string, unknown> = {},
) => ({
  kind: 'claim-result',
  candidate_run_id: source.runId,
  candidate_job_id: source.jobId,
  candidate_event_id: source.eventId,
  candidate_workflow_instance_id: source.workflowInstanceId,
  candidate_dispatch_generation: source.dispatchGeneration + 1,
  claim_accepted: accepted ? 1 : 0,
  run_mode: 'execute',
  run_status: 'executing',
  run_id: source.runId,
  job_id: source.jobId,
  event_id: source.eventId,
  workflow_instance_id: source.workflowInstanceId,
  dispatch_state: accepted ? 'creating' : 'pending',
  dispatch_generation: accepted ? source.dispatchGeneration + 1 : source.dispatchGeneration,
  status: 'queued',
  fence_state: accepted ? 'open' : null,
  fence_generation: accepted ? source.dispatchGeneration + 1 : null,
  ...overrides,
});

const confirmWireRow = (overrides: Record<string, unknown> = {}) => ({
  kind: 'confirm',
  run_id: RUN,
  job_id: JOB,
  event_id: EVENT,
  workflow_instance_id: `cb1-${'0'.repeat(48)}`,
  dispatch_state: 'creating',
  dispatch_generation: 1,
  status: 'queued',
  fence_state: 'open',
  fence_generation: 1,
  ...overrides,
});

const expectation = { runId: RUN, jobId: JOB, eventId: EVENT, generation: 1, now: NOW };

const runState = (overrides: Partial<RunStateRow> = {}): RunStateRow => ({
  runId: RUN,
  mode: 'inventory',
  status: 'inventorying',
  cursor: EVENT,
  inventorySha256: 'b'.repeat(64),
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * Schema and resource pins
 * ------------------------------------------------------------------ */

const migrationSql = readFileSync(
  resolve(process.cwd(), 'migrations/0012_event_cover_storage.sql'),
  'utf8',
);
const wranglerConfig = readFileSync(resolve(process.cwd(), 'wrangler.jsonc'), 'utf8');

function tableBlock(name: string): string {
  const start = migrationSql.indexOf(`CREATE TABLE ${name} (`);
  expect(start).toBeGreaterThan(-1);
  const end = migrationSql.indexOf('\n);', start);
  expect(end).toBeGreaterThan(start);
  return migrationSql.slice(start, end);
}

function checkList(block: string, column: string): string[] {
  const marker = `CHECK (${column} IN (`;
  const start = block.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const from = start + marker.length;
  const end = block.indexOf('))', from);
  expect(end).toBeGreaterThan(from);
  return block.slice(from, end)
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/gu, ''))
    .filter((entry) => entry.length > 0);
}

describe('the launcher is pinned to the same contract the Workflow renders under', () => {
  it('restates exactly the nine source-independent version axes', () => {
    expect(COVER_BACKFILL_DEPENDENCY_VERSIONS).toEqual({
      normalizationLadder: COVER_PIPELINE_VERSIONS.normalizationLadder,
      imagesParameterRecipe: COVER_PIPELINE_VERSIONS.imagesParameterRecipe,
      matte: COVER_PIPELINE_VERSIONS.matte,
      metadataPolicy: COVER_PIPELINE_VERSIONS.metadataPolicy,
      compositionModel: COVER_PIPELINE_VERSIONS.compositionModel,
      cropProfileRegistry: COVER_PIPELINE_VERSIONS.cropProfileRegistry,
      tonalEffect: COVER_PIPELINE_VERSIONS.tonalEffect,
      sharpening: COVER_PIPELINE_VERSIONS.sharpening,
      outputQualityLadder: COVER_PIPELINE_VERSIONS.outputQualityLadder,
    });
    // Source-dependent axes are deliberately absent: a preview recipe or preset
    // asset version has nothing to do with converting a legacy original.
    expect(COVER_BACKFILL_DEPENDENCY_VERSIONS).not.toHaveProperty('previewRecipe');
    expect(COVER_BACKFILL_DEPENDENCY_VERSIONS).not.toHaveProperty('presetAsset');
  });

  it('derives the instance ID the Worker derives', () => {
    // tests/worker/cover-backfill-workflow.test.ts pins this identical literal
    // against `coverBackfillInstanceId`. Neither derivation may move alone.
    expect(backfillInstanceId(RUN, JOB, EVENT))
      .toBe('cb1-a07817264cb28dc8a121972f6c5e94f0d2cddca0d93f30f3');
    expect(backfillInstanceId(RUN, JOB, OTHER_EVENT)).not.toBe(backfillInstanceId(RUN, JOB, EVENT));
  });

  it('fingerprints an object key the way the Worker does', () => {
    expect(fingerprintKey(`events/${EVENT}/cover/legacy.jpg`))
      .toBe('af832e5d3d0474f8e02e10c5a59c71f68574d294543399824fe83e2399527fbf');
  });

  /**
   * The script cannot import `worker/db/types.ts` — it is a different build
   * project, and Node's type stripping cannot follow the extensionless imports
   * underneath it. It restates the three unions instead, so they are pinned to
   * `0012`'s CHECK constraints directly rather than to a copy that could drift
   * with them.
   */
  it('restates the job, dispatch, and fence vocabularies exactly as 0012 constrains them', () => {
    const jobs = tableBlock('event_cover_backfill_jobs');
    expect([...COVER_DISPATCH_STATES]).toEqual(checkList(jobs, 'dispatch_state'));
    expect([...COVER_BACKFILL_JOB_STATUSES]).toEqual(checkList(jobs, 'status'));
    expect([...COVER_FENCE_STATES])
      .toEqual(checkList(tableBlock('event_cover_workflow_fences'), 'state'));
    expect([...COVER_BACKFILL_RUN_MODES])
      .toEqual(checkList(tableBlock('event_cover_backfill_runs'), 'mode'));
    expect(COVER_BACKFILL_RUN_MODES).not.toContain('launch');
  });

  it('names the exact resources wrangler.jsonc binds', () => {
    expect(wranglerConfig).toContain(`"database_name": "${COVER_BACKFILL_DATABASE_NAME}"`);
    expect(wranglerConfig).toContain(`"database_id": "${COVER_BACKFILL_DATABASE_ID}"`);
    expect(wranglerConfig).toContain(`"name": "${COVER_BACKFILL_WORKFLOW_NAME}"`);
    expect(wranglerConfig).toContain(`"binding": "${COVER_BACKFILL_BINDING}"`);
    expect(wranglerConfig).toMatch(
      new RegExp(`^\\s*"name": "${COVER_BACKFILL_WORKER_NAME}",`, 'mu'),
    );
    expect(existsSync(resolve(process.cwd(), WRANGLER_CONFIG_PATH))).toBe(true);
  });
});

describe('the read-only inventory statement', () => {
  it('selects on the indexable legacy predicate and one page', () => {
    const sql = inventorySql(null);
    expect(sql).toContain('cover_object_key IS NOT NULL');
    expect(sql).toContain('cover_render_set_id IS NULL');
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain(`LIMIT ${MAX_COVER_BACKFILL_PAGE_SIZE}`);
    // A JSON probe would scan every event and would also sweep up presets,
    // which have a null key and a null set and are not legacy rows.
    expect(sql).not.toContain('cover_config');
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/u);
  });

  it('resumes from a cursor and refuses one that is not an event ID', () => {
    expect(inventorySql(EVENT)).toContain(`id > '${EVENT}'`);
    expect(() => inventorySql("x' OR 1=1 --")).toThrow(/cursor/u);
  });

  it('states the proof as four independent counts', () => {
    const sql = proofSql();
    for (const name of ['legacyRows', 'blockingJobs', 'incompleteActiveSets', 'uploadsWithoutActiveSet']) {
      expect(sql).toContain(name);
    }
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/u);
  });
});

describe('payload parsing', () => {
  it('accepts a wrangler envelope and a bare row array', () => {
    const rows = [{ id: EVENT, cover_object_key: 'events/a/cover/x', cover_revision: 2 }];
    expect(parseInventoryPayload(envelope(rows))).toEqual(rows);
    expect(parseInventoryPayload(rows)).toEqual(rows);
  });

  it('refuses a page larger than the bound and any row missing its identity', () => {
    const oversized = Array.from({ length: MAX_COVER_BACKFILL_PAGE_SIZE + 1 }, () => ({
      id: EVENT, cover_object_key: 'k', cover_revision: 0,
    }));
    expect(() => parseInventoryPayload(envelope(oversized))).toThrow(/page size/u);
    expect(() => parseInventoryPayload(envelope([{ id: 'nope', cover_object_key: 'k', cover_revision: 0 }])))
      .toThrow(/event ID/u);
    expect(() => parseInventoryPayload(envelope([{ id: EVENT, cover_object_key: '', cover_revision: 0 }])))
      .toThrow(/legacy cover key/u);
    expect(() => parseInventoryPayload(envelope([{ id: EVENT, cover_object_key: 'k', cover_revision: -1 }])))
      .toThrow(/cover revision/u);
    expect(() => parseInventoryPayload({ nope: true })).toThrow(/wrangler/u);
  });

  it('reads a grouped count payload', () => {
    expect(parseCountPayload(envelope([{ status: 'queued', value: 3 }]))).toEqual({ queued: 3 });
    expect(() => parseCountPayload(envelope([{ status: 'queued' }]))).toThrow(/name\/value/u);
  });
});

describe('the inventory digest', () => {
  it('is stable, order-sensitive, and carries no object key', () => {
    const first = [row(EVENT, 'events/a/cover/one'), row(OTHER_EVENT, 'events/b/cover/two')];
    const reversed = [first[1]!, first[0]!];
    expect(inventoryDigest(first)).toBe(inventoryDigest([...first]));
    expect(inventoryDigest(first)).not.toBe(inventoryDigest(reversed));
    expect(inventoryDigest(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(inventoryDigest(first)).not.toContain('cover');
  });

  /**
   * A per-page digest cannot prove what a multi-page run inventoried. The
   * rolling form chains each page into the last so the stored value is a
   * commitment to the whole ordered walk, and re-applying one page changes it.
   */
  it('rolls each page into the previous one', () => {
    const page = [row(EVENT, 'events/a/cover/one')];
    expect(rollingInventoryDigest(null, page)).toBe(inventoryDigest(page));

    const chained = rollingInventoryDigest(inventoryDigest(page), page);
    expect(chained).toMatch(/^[0-9a-f]{64}$/u);
    expect(chained).not.toBe(inventoryDigest(page));
    expect(rollingInventoryDigest(inventoryDigest(page), page)).toBe(chained);

    const other = [row(OTHER_EVENT, 'events/b/cover/two')];
    expect(rollingInventoryDigest(inventoryDigest(page), other)).not.toBe(chained);
    expect(() => rollingInventoryDigest('short', page)).toThrow(/digest/u);
  });
});

describe('the run plan', () => {
  const rows = [row(EVENT, 'events/a/cover/one', 3), row(OTHER_EVENT, 'events/b/cover/two', 0)];
  const jobIds = () => {
    let index = 0;
    return () => [JOB, '55555555-5555-4555-8555-555555555555'][index++]!;
  };
  const plan = (newRun: boolean) => buildBackfillRunPlan({
    runId: RUN,
    rows,
    now: NOW,
    runState: newRun ? null : runState({ cursor: null, inventorySha256: null }),
    makeJobId: jobIds(),
  });

  it('creates the run row once and updates its cursor afterwards', () => {
    expect(plan(true).statements[0]).toContain('INSERT INTO event_cover_backfill_runs');
    expect(plan(true).statements[0]).toContain("'inventorying'");
    expect(plan(false).statements[0]).toContain('UPDATE event_cover_backfill_runs');
  });

  it('carries the cursor, digest, and a job per row', () => {
    const built = plan(true);
    expect(built.cursor).toBe(OTHER_EVENT);
    expect(built.inventorySha256).toBe(inventoryDigest(rows));
    expect(built.jobs).toHaveLength(2);
    expect(built.jobs[0]!.expectedRevision).toBe(3);
    expect(built.jobs[0]!.legacyKeyFingerprint).toBe(fingerprintKey('events/a/cover/one'));
    expect(built.jobs[0]!.workflowInstanceId).toBe(backfillInstanceId(RUN, JOB, EVENT));
  });

  it('guards every job insert on all four predicates and on not already existing', () => {
    const insert = plan(true).statements[1]!;
    expect(insert).toContain('cover_object_key IS NOT NULL');
    expect(insert).toContain('cover_render_set_id IS NULL');
    expect(insert).toContain('deleted_at IS NULL');
    expect(insert).toContain('cover_revision = 3');
    // A second inventory pass over the same run must not allocate a second job
    // for an event that already has one.
    expect(insert).toContain('NOT EXISTS (SELECT 1 FROM event_cover_backfill_jobs');
    expect(insert).toContain("'queued'");
    expect(insert).toContain("'pending'");
    expect(insert).toContain(JSON.stringify(COVER_BACKFILL_DEPENDENCY_VERSIONS));
    expect(insert).toContain("r.mode = 'inventory'");
    expect(insert).toContain("r.status = 'inventorying'");
  });

  it('replays the full saved initial inventory page idempotently', () => {
    const database = migratedDatabase();
    try {
      database.prepare(`
        INSERT INTO events (
          id, slug, name, event_date, welcome_message, cover_object_key,
          guest_access_expires_at, management_access_expires_at, purge_after, created_at
        ) VALUES (?, 'saved-replay', 'Saved replay', '2026-08-08', 'Welcome', ?, ?, ?, ?, ?)
      `).run(EVENT, 'events/a/cover/one', NOW, NOW, NOW, NOW);
      const saved = buildBackfillRunPlan({
        runId: RUN,
        rows: [row(EVENT, 'events/a/cover/one')],
        now: NOW,
        runState: null,
        makeJobId: () => JOB,
      });

      database.exec(saved.statements.join('\n'));
      database.exec(saved.statements.join('\n'));

      expect(database.prepare(`
        SELECT cursor, inventory_sha256, total_count, queued_count
        FROM event_cover_backfill_runs WHERE id = ?
      `).get(RUN)).toEqual({
        cursor: EVENT, inventory_sha256: saved.inventorySha256,
        total_count: 1, queued_count: 1,
      });
      expect(database.prepare(
        'SELECT count(*) AS count FROM event_cover_backfill_jobs WHERE run_id = ?',
      ).get(RUN)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('cannot apply the full saved initial inventory page after its run has closed', () => {
    const database = migratedDatabase();
    try {
      database.prepare(`
        INSERT INTO events (
          id, slug, name, event_date, welcome_message, cover_object_key,
          guest_access_expires_at, management_access_expires_at, purge_after, created_at
        ) VALUES (?, 'saved-page', 'Saved page', '2026-08-08', 'Welcome', ?, ?, ?, ?, ?)
      `).run(EVENT, 'events/a/cover/one', NOW, NOW, NOW, NOW);
      const saved = buildBackfillRunPlan({
        runId: RUN,
        rows: [row(EVENT, 'events/a/cover/one')],
        now: NOW,
        runState: null,
        makeJobId: () => JOB,
      });

      database.exec(saved.statements.join('\n'));
      database.prepare(`
        UPDATE event_cover_backfill_runs
        SET mode = 'verify', status = 'verified', total_count = 7, queued_count = 7
        WHERE id = ?
      `).run(RUN);
      database.exec(saved.statements.join('\n'));

      expect(database.prepare(
        'SELECT count(*) AS count FROM event_cover_backfill_jobs WHERE run_id = ?',
      ).get(RUN)).toEqual({ count: 1 });
      expect(database.prepare(`
        SELECT mode, status, total_count, queued_count
        FROM event_cover_backfill_runs WHERE id = ?
      `).get(RUN)).toEqual({
        mode: 'verify', status: 'verified', total_count: 7, queued_count: 7,
      });
    } finally {
      database.close();
    }
  });

  it('refreshes literal run counters after every accepted inventory page', () => {
    const database = migratedDatabase();
    try {
      for (const [id, slug, key, revision] of [
        [EVENT, 'counter-a', 'events/a/cover/one', 3],
        [OTHER_EVENT, 'counter-b', 'events/b/cover/two', 0],
      ] as const) {
        database.prepare(`
          INSERT INTO events (
            id, slug, name, event_date, welcome_message, cover_object_key,
            cover_revision, guest_access_expires_at, management_access_expires_at,
            purge_after, created_at
          ) VALUES (?, ?, 'Counter', '2026-08-08', 'Welcome', ?, ?, ?, ?, ?, ?)
        `).run(id, slug, key, revision, NOW, NOW, NOW, NOW);
      }
      const saved = plan(true);
      database.exec(saved.statements.join('\n'));

      expect(database.prepare(`
        SELECT total_count, queued_count, applied_count, failed_count
        FROM event_cover_backfill_runs WHERE id = ?
      `).get(RUN)).toEqual({
        total_count: 2, queued_count: 2, applied_count: 0, failed_count: 0,
      });
    } finally {
      database.close();
    }
  });

  it('lets a lost page-header guard change neither jobs nor counters', () => {
    const database = migratedDatabase();
    try {
      database.prepare(`
        INSERT INTO events (
          id, slug, name, event_date, welcome_message, cover_object_key,
          guest_access_expires_at, management_access_expires_at, purge_after, created_at
        ) VALUES (?, 'lost-header', 'Lost header', '2026-08-08', 'Welcome', ?, ?, ?, ?, ?)
      `).run(EVENT, 'events/a/cover/one', NOW, NOW, NOW, NOW);
      database.prepare(`
        INSERT INTO event_cover_backfill_runs (
          id, mode, cursor, inventory_sha256, total_count, queued_count,
          status, created_at, updated_at
        ) VALUES (?, 'inventory', ?, ?, 7, 7, 'inventorying', ?, ?)
      `).run(RUN, OTHER_EVENT, 'f'.repeat(64), NOW, NOW);
      const stale = buildBackfillRunPlan({
        runId: RUN,
        rows: [row(EVENT, 'events/a/cover/one')],
        now: NOW,
        runState: runState({ cursor: null, inventorySha256: null }),
        makeJobId: () => JOB,
      });

      database.exec(stale.statements.join('\n'));

      expect(database.prepare(`
        SELECT cursor, inventory_sha256, total_count, queued_count
        FROM event_cover_backfill_runs WHERE id = ?
      `).get(RUN)).toEqual({
        cursor: OTHER_EVENT, inventory_sha256: 'f'.repeat(64), total_count: 7, queued_count: 7,
      });
      expect(database.prepare(`
        SELECT count(*) AS count FROM event_cover_backfill_jobs WHERE run_id = ?
      `).get(RUN)).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('has a null cursor for an empty page and refuses an oversized one', () => {
    const empty = buildBackfillRunPlan({ runId: RUN, rows: [], now: NOW, runState: null });
    expect(empty.cursor).toBeNull();
    expect(empty.inventorySha256).toBe(inventoryDigest([]));
    expect(empty.inventoryExhausted).toBe(true);
    expect(empty.statements).toHaveLength(2);
    expect(empty.statements[1]).toContain('cursor IS NULL');
    expect(empty.statements[1]).toContain(`inventory_sha256 = '${inventoryDigest([])}'`);
    expect(() => buildBackfillRunPlan({
      runId: RUN,
      rows: Array.from({ length: MAX_COVER_BACKFILL_PAGE_SIZE + 1 }, () => row(EVENT, 'k')),
      now: NOW,
      runState: null,
    })).toThrow(/page size/u);
    expect(() => buildBackfillRunPlan({ runId: 'nope', rows: [], now: NOW, runState: null }))
      .toThrow(/UUID/u);
    expect(() => buildBackfillRunPlan({ runId: RUN, rows: [], now: 'yesterday', runState: null }))
      .toThrow(/instant/u);
  });

  it('replays the full saved empty initial page idempotently', () => {
    const database = migratedDatabase();
    try {
      const empty = buildBackfillRunPlan({ runId: RUN, rows: [], now: NOW, runState: null });

      database.exec(empty.statements.join('\n'));
      database.exec(empty.statements.join('\n'));

      expect(database.prepare(`
        SELECT mode, status, cursor, inventory_sha256, total_count, queued_count
        FROM event_cover_backfill_runs WHERE id = ?
      `).get(RUN)).toEqual({
        mode: 'execute', status: 'executing', cursor: null,
        inventory_sha256: inventoryDigest([]), total_count: 0, queued_count: 0,
      });
    } finally {
      database.close();
    }
  });

  /**
   * The defect this replaces: an empty page on a resumed run rewrote `cursor`
   * to NULL, so the next inventory pass restarted from the first event ID and
   * proposed a duplicate job for every row it had already committed.
   */
  it('keeps the durable cursor when a resumed page comes back empty', () => {
    const resumed = buildBackfillRunPlan({
      runId: RUN,
      rows: [],
      now: NOW,
      runState: runState({ cursor: OTHER_EVENT, inventorySha256: 'c'.repeat(64) }),
    });
    expect(resumed.cursor).toBe(OTHER_EVENT);
    expect(resumed.inventorySha256).toBe('c'.repeat(64));
    expect(resumed.statements).toHaveLength(1);
    expect(resumed.statements[0]).not.toContain('SET cursor =');
    expect(resumed.statements[0]).toContain(`AND cursor = '${OTHER_EVENT}'`);
    expect(resumed.statements[0]).toContain(`inventory_sha256 = '${'c'.repeat(64)}'`);
    expect(resumed.statements[0]).not.toContain('NULL');
  });

  /** The empty page is the durable end-of-inventory marker, and the only one. */
  it('marks the end of inventory by moving the run to execute/executing', () => {
    const resumed = buildBackfillRunPlan({
      runId: RUN,
      rows: [],
      now: NOW,
      runState: runState({ cursor: OTHER_EVENT }),
    });
    expect(resumed.inventoryExhausted).toBe(true);
    expect(resumed.statements[0]).toContain("mode = 'execute'");
    expect(resumed.statements[0]).toContain("status = 'executing'");
    expect(resumed.statements[0]).toContain("status = 'inventorying'");
    expect(resumed.jobs).toEqual([]);
  });

  it('recomputes counters in the exact empty-page inventory handoff', () => {
    const database = migratedDatabase();
    try {
      for (const [id, slug] of [[EVENT, 'handoff-a'], [OTHER_EVENT, 'handoff-b']] as const) {
        database.prepare(`
          INSERT INTO events (
            id, slug, name, event_date, welcome_message,
            guest_access_expires_at, management_access_expires_at, purge_after, created_at
          ) VALUES (?, ?, 'Handoff', '2026-08-08', 'Welcome', ?, ?, ?, ?)
        `).run(id, slug, NOW, NOW, NOW, NOW);
      }
      database.prepare(`
        INSERT INTO event_cover_backfill_runs (
          id, mode, cursor, inventory_sha256, status, created_at, updated_at
        ) VALUES (?, 'inventory', ?, ?, 'inventorying', ?, ?)
      `).run(RUN, OTHER_EVENT, 'd'.repeat(64), NOW, NOW);
      const insertJob = database.prepare(`
        INSERT INTO event_cover_backfill_jobs (
          id, run_id, event_id, expected_revision, legacy_key_fingerprint,
          workflow_instance_id, dispatch_state, dispatch_generation, status,
          dependency_versions_json, terminal_at, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, ?, 'confirmed', 1, ?, '{}', ?, ?, ?)
      `);
      insertJob.run(JOB, RUN, EVENT, 'a'.repeat(64), `cb1-${'1'.repeat(48)}`, 'queued', null, NOW, NOW);
      insertJob.run(
        '55555555-5555-4555-8555-555555555555', RUN, OTHER_EVENT, 'b'.repeat(64),
        `cb1-${'2'.repeat(48)}`, 'applied', NOW, NOW, NOW,
      );
      const exhausted = buildBackfillRunPlan({
        runId: RUN, rows: [], now: NOW,
        runState: runState({ cursor: OTHER_EVENT, inventorySha256: 'd'.repeat(64) }),
      });

      database.exec(exhausted.statements.join('\n'));

      expect(database.prepare(`
        SELECT mode, status, total_count, queued_count, applied_count
        FROM event_cover_backfill_runs WHERE id = ?
      `).get(RUN)).toEqual({
        mode: 'execute', status: 'executing', total_count: 2, queued_count: 1, applied_count: 1,
      });
    } finally {
      database.close();
    }
  });

  it('refuses a stale empty-page handoff after a newer page advanced the run', () => {
    const database = migratedDatabase();
    try {
      database.prepare(`
        INSERT INTO event_cover_backfill_runs (
          id, mode, cursor, inventory_sha256, total_count, queued_count,
          status, created_at, updated_at
        ) VALUES (?, 'inventory', ?, ?, 7, 7, 'inventorying', ?, ?)
      `).run(RUN, OTHER_EVENT, 'f'.repeat(64), NOW, NOW);
      const staleEmpty = buildBackfillRunPlan({
        runId: RUN, rows: [], now: NOW,
        runState: runState({ cursor: EVENT, inventorySha256: 'd'.repeat(64) }),
      });

      database.exec(staleEmpty.statements.join('\n'));

      expect(database.prepare(`
        SELECT mode, status, cursor, inventory_sha256, total_count, queued_count
        FROM event_cover_backfill_runs WHERE id = ?
      `).get(RUN)).toEqual({
        mode: 'inventory', status: 'inventorying', cursor: OTHER_EVENT,
        inventory_sha256: 'f'.repeat(64), total_count: 7, queued_count: 7,
      });
    } finally {
      database.close();
    }
  });

  it('chains the stored digest and refuses to rewind the cursor', () => {
    const stored = runState({ cursor: '00000000-0000-4000-8000-000000000000', inventorySha256: 'd'.repeat(64) });
    const resumed = buildBackfillRunPlan({
      runId: RUN, rows, now: NOW, runState: stored, makeJobId: jobIds(),
    });
    expect(resumed.inventoryExhausted).toBe(false);
    expect(resumed.inventorySha256).toBe(rollingInventoryDigest('d'.repeat(64), rows));
    expect(resumed.statements[0]).toContain(`cursor < '${OTHER_EVENT}'`);
    expect(resumed.statements[0]).toContain(`inventory_sha256 = '${'d'.repeat(64)}'`);
    expect(resumed.statements[0]).toContain("status = 'inventorying'");
  });

  it('refuses a run state that is not the run being resumed, or is already closed', () => {
    for (const state of [
      runState({ runId: OTHER_RUN }),
      runState({ status: 'verified' }),
      runState({ status: 'failed' }),
      runState({ mode: 'verify' }),
    ]) {
      expect(() => buildBackfillRunPlan({ runId: RUN, rows, now: NOW, runState: state }))
        .toThrow(/run state/u);
    }
  });

  /** Only `dispatch` may emit a Workflow command, and only for a committed row. */
  it('never emits a Workflow command or a fence for a proposed job', () => {
    const built = plan(true);
    const text = built.statements.join('\n');
    expect(text).not.toContain('event_cover_workflow_fences');
    expect(text).not.toContain('wrangler');
    expect(built).not.toHaveProperty('commands');
  });
});

describe('the durable dispatch read', () => {
  it('is read-only, run-scoped, and self-identifying', () => {
    const sql = dispatchSql(RUN);
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/u);
    expect(sql).toContain(`j.run_id = '${RUN}'`);
    expect(sql).toContain("'dispatchable' AS kind");
    for (const kind of ['nonterminal', 'activeRuns', 'minuteClaims', 'retryable', 'latestClaimAt']) {
      expect(sql).toContain(`'${kind}'`);
    }
    // Only a row that is committed, pending, and unclaimed may be offered.
    expect(sql).toContain("j.dispatch_state = 'pending'");
    expect(sql).toContain("j.status = 'queued'");
    expect(sql).toContain('e.deleted_at IS NULL');
    expect(sql).toContain('event_cover_purge_progress');
    expect(sql).toContain(`LIMIT ${MAX_COVER_BACKFILL_CREATE_BATCH}`);
    // The rolling minute is measured by the database's clock, not the operator's.
    expect(sql).toContain("'-60 seconds'");
    expect(() => dispatchSql('nope')).toThrow(/UUID/u);
  });

  it('parses only rows the database returned', () => {
    const source = dispatchRow(1);
    const parsed = parseDispatchPayload(dispatchPayload([source], { nonterminal: 4, activeRuns: 1 }));
    expect(parsed.rows).toEqual([source]);
    expect(parsed.nonterminal).toBe(4);
    expect(parsed.activeRuns).toBe(1);
    expect(parsed.latestClaimAt).toBeNull();
  });

  it('exposes jobs only while their run is execute/executing in migrated D1', () => {
    const cases = [
      { runMode: 'inventory', runStatus: 'inventorying' },
      { runMode: 'execute', runStatus: 'verified' },
      { runMode: 'execute', runStatus: 'failed' },
      { runMode: 'verify', runStatus: 'executing' },
    ] as const;

    for (const input of cases) {
      const database = migratedDatabase();
      try {
        seedDispatchCandidate(database, input);
        expect(dispatchRows(database), `${input.runMode}/${input.runStatus}`).toEqual([]);
      } finally {
        database.close();
      }
    }

    const database = migratedDatabase();
    try {
      seedDispatchCandidate(database);
      expect(dispatchRows(database)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('refuses a payload missing a counter, carrying an unknown kind, or a bad row', () => {
    expect(() => parseDispatchPayload(envelopes([], [{ kind: 'nonterminal', value: 0, at: null }])))
      .toThrow(/activeRuns/u);
    expect(() => parseDispatchPayload(envelopes([{ kind: 'surprise' }], counterRows())))
      .toThrow(/kind/u);
    expect(() => parseDispatchPayload(envelopes(
      [{ ...dispatchWireRow(dispatchRow(1)), dispatch_state: 'nonsense' }],
      counterRows(),
    ))).toThrow(/dispatch state/u);
    expect(() => parseDispatchPayload(envelopes(
      [{ ...dispatchWireRow(dispatchRow(1)), workflow_instance_id: 'not-an-instance' }],
      counterRows(),
    ))).toThrow(/instance/u);
    expect(() => parseDispatchPayload(envelopes(
      [{ ...dispatchWireRow(dispatchRow(1)), fence_state: 'melted' }],
      counterRows(),
    ))).toThrow(/fence state/u);
  });
});

describe('the dispatch batch', () => {
  const rows = Array.from({ length: 40 }, (_unused, index) => dispatchRow(index));
  const batch = (
    overrides: Partial<Parameters<typeof buildDispatchBatch>[0]> = {},
  ) => buildDispatchBatch({
    runId: RUN, rows, nonterminal: 0, activeRuns: 0, minuteClaims: 0, latestClaimAt: null, now: NOW,
    ...overrides,
  });

  it('creates nothing at all once the in-flight ceiling is reached', () => {
    const full = batch({ nonterminal: MAX_COVER_BACKFILL_IN_FLIGHT });
    expect(full.create).toEqual([]);
    expect(full).not.toHaveProperty('commands');
    expect(full.fenceStatements).toEqual([]);
    expect(full.withheld.inFlight).toBe(40);
    expect(full.limitingBound).toBe('in-flight');
  });

  it('takes the tightest of the bounds', () => {
    const empty = batch();
    expect(empty.create).toHaveLength(
      Math.min(MAX_COVER_BACKFILL_CREATE_BATCH, MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE),
    );
    expect(empty.withheld.batch).toBe(40 - empty.create.length);

    const nearlyFull = batch({ nonterminal: MAX_COVER_BACKFILL_IN_FLIGHT - 3 });
    expect(nearlyFull.create).toHaveLength(3);
    expect(nearlyFull.withheld.inFlight).toBe(37);
    expect(nearlyFull.limitingBound).toBe('in-flight');
  });

  /** One batch per minute, measured from the last durable fence claim. */
  it('withholds the whole batch while this minute is already spent', () => {
    const spent = batch({
      minuteClaims: MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
      latestClaimAt: '2026-08-05T09:59:30.000Z',
    });
    expect(spent.create).toEqual([]);
    expect(spent.withheld.minute).toBe(40);
    expect(spent.limitingBound).toBe('minute');
    expect(spent.notBefore).toBe('2026-08-05T10:00:30.000Z');
  });

  it('never runs beside another active run', () => {
    const contended = batch({ activeRuns: 1 });
    expect(contended.create).toEqual([]);
    expect(contended).not.toHaveProperty('commands');
    expect(contended.blockedByActiveRun).toBe(true);
    expect(contended.withheld.activeRun).toBe(40);
  });

  /**
   * A fence the purge coordinator owns is the one thing that must never be
   * triggered, and a fence at another generation is ambiguous rather than safe.
   */
  it('excludes a blocked fence and a fence at a different generation', () => {
    const excluded = buildDispatchBatch({
      runId: RUN,
      rows: [
        dispatchRow(1, { fenceState: 'deletion-blocked', fenceGeneration: 0 }),
        dispatchRow(2, { fenceState: 'open', fenceGeneration: 4 }),
        dispatchRow(3, { fenceState: 'open', fenceGeneration: 0 }),
        dispatchRow(4),
      ],
      nonterminal: 0, activeRuns: 0, minuteClaims: 0, latestClaimAt: null, now: NOW,
    });
    expect(excluded.create.map((entry) => entry.jobId))
      .toEqual([dispatchRow(3).jobId, dispatchRow(4).jobId]);
    expect(excluded.withheld.fence).toBe(2);
  });

  it('carries only the stored identifiers into the artifact', () => {
    const one = buildDispatchBatch({
      runId: RUN, rows: [dispatchRow(7)], nonterminal: 0, activeRuns: 0, minuteClaims: 0,
      latestClaimAt: null, now: NOW,
    });
    expect(one.fenceStatements[0]).toContain(`'${COVER_BACKFILL_BINDING}'`);
    expect(one.fenceStatements[0]).toContain("'open'");
    expect(one.fenceStatements[0]).toContain("'9999-12-31T23:59:59.999Z'");
    expect(one.fenceStatements[0]).toContain('ON CONFLICT');
    // A fence carries no foreign key to `events`, so nothing in the schema stops
    // a stale artifact from opening one behind a purge that has already left the
    // fences phase — and no later phase would ever settle it.
    expect(one.fenceStatements[0]).toContain('deleted_at IS NULL');
    expect(one.fenceStatements[0]).toContain('event_cover_purge_progress');
    expect(one.claimStatements.join('\n')).not.toContain('cover_object_key');
    expect(one.notBefore).toBe(NOW);
  });

  it('refuses a negative count or a row belonging to another run', () => {
    expect(() => batch({ nonterminal: -1 })).toThrow(/negative/u);
    expect(() => batch({ minuteClaims: -1 })).toThrow(/negative/u);
    expect(() => buildDispatchBatch({
      runId: RUN, rows: [dispatchRow(1, { runId: OTHER_RUN })], nonterminal: 0, activeRuns: 0,
      minuteClaims: 0, latestClaimAt: null, now: NOW,
    })).toThrow(/run/u);
  });

  /**
   * Read off `wrangler workflows --help` at 4.113.0, not inferred.
   *
   * The first version of this suite asserted the launcher's own invented string,
   * which is exactly how it shipped emitting `workflows instances create` — a
   * subcommand that does not exist. These assertions pin the emitted command
   * against the documented vocabulary instead: creation is `trigger`, the params
   * are positional, and `--id` is the only way to give an instance the
   * deterministic ID its fence is keyed by.
   */
  it('emits the creation command wrangler actually has', () => {
    const source = dispatchRow(3);
    const one = buildLaunchPlan({
      runId: RUN,
      candidates: [claimCandidate(source)],
      results: parseClaimedDispatchPayload(envelope([claimedWireRow(source, true)])),
    });

    expect(one.commands[0]).toBe(
      'npx wrangler workflows trigger candidary-cover-backfill '
      + `'{"runId":"${RUN}","jobId":"${source.jobId}","eventId":"${source.eventId}"}'`
      + ` --id ${source.workflowInstanceId} --config ${WRANGLER_CONFIG_PATH}`,
    );
    expect(one.commands[0]).not.toContain('instances create');
    expect(one.commands[0]).not.toContain('--params');
  });

  it('emits a PowerShell-quoted form beside it, because that is the shell here', () => {
    const source = dispatchRow(4);
    const one = buildLaunchPlan({
      runId: RUN,
      candidates: [claimCandidate(source)],
      results: parseClaimedDispatchPayload(envelope([claimedWireRow(source, true)])),
    });

    // A single-quoted JSON payload survives POSIX and is eaten by PowerShell, so
    // the operator gets the doubled-quote form rather than an instance created
    // with no parameters at all.
    expect(one.powershellCommands[0]).toContain('""runId""');
    expect(one.powershellCommands[0]).toContain(`--id ${source.workflowInstanceId}`);
    expect(one.powershellCommands[0]).not.toContain("'{");
    expect(JSON.parse(
      one.powershellCommands[0]!.slice(
        one.powershellCommands[0]!.indexOf('"{'),
        one.powershellCommands[0]!.lastIndexOf('}"') + 2,
      ).slice(1, -1).replace(/""/gu, '"'),
    )).toEqual({ runId: RUN, jobId: source.jobId, eventId: source.eventId });
  });
});

/**
 * Wrangler 4.113 has `--remote` on `d1 execute` and does **not** have it on
 * `workflows trigger` or `workflows instances terminate`, which take `--local`
 * or nothing. Emitting `--remote` on a Workflow command is an unknown-argument
 * error, so "always pass --remote" is not a rule that can be applied uniformly.
 */
describe('remote targeting', () => {
  it('proves the account and the database before anything else runs', () => {
    const [account, database, ...rest] = identityCheckCommands();
    expect(account).toBe('npx wrangler whoami --json');
    expect(database).toBe(
      `npx wrangler d1 info ${COVER_BACKFILL_DATABASE_NAME} --config ${WRANGLER_CONFIG_PATH} --json`,
    );
    expect(rest).toEqual([]);
  });

  it('marks every D1 command remote and names the exact database and config', () => {
    const read = d1ReadCommands(dispatchSql(RUN));
    for (const command of [read.posix, read.powershell, d1FileCommand('output/x.sql')]) {
      expect(command).toContain(`wrangler d1 execute ${COVER_BACKFILL_DATABASE_NAME}`);
      expect(command).toContain('--remote');
      expect(command).toContain(`--config ${WRANGLER_CONFIG_PATH}`);
      expect(command).toContain('--json');
      expect(command).not.toContain('--local');
    }
  });

  it('never marks a Workflow command remote and never marks one local', () => {
    const source = dispatchRow(1);
    const one = buildLaunchPlan({
      runId: RUN,
      candidates: [claimCandidate(source)],
      results: parseClaimedDispatchPayload(envelope([claimedWireRow(source, true)])),
    });
    for (const command of [...one.commands, ...one.powershellCommands]) {
      expect(command).toContain(`--config ${WRANGLER_CONFIG_PATH}`);
      expect(command).not.toContain('--remote');
      expect(command).not.toContain('--local');
    }
  });
});

/**
 * The claim is the one artifact that changes durable state before the platform
 * is touched, so every refusal it can make is re-evaluated by the database at
 * apply time rather than inherited from the read that produced it.
 */
describe('the transactional claim', () => {
  const one = () => buildDispatchBatch({
    runId: RUN, rows: [dispatchRow(1)], nonterminal: 0, activeRuns: 0, minuteClaims: 0,
    latestClaimAt: null, now: NOW,
  });

  it('opens the fence, then moves the job and the fence to the next generation', () => {
    const [fence, job, fenceClaim, cleanup, ...rest] = one().claimStatements;
    expect(rest).toEqual([]);
    expect(fence).toContain('INSERT INTO event_cover_workflow_fences');
    expect(job).toContain("dispatch_state = 'creating'");
    expect(job).toContain('dispatch_generation = dispatch_generation + 1');
    expect(job).toContain("dispatch_state = 'pending'");
    expect(job).toContain("status = 'queued'");
    // The fence moves only if the job did, and it takes the job's new generation
    // rather than a number the artifact carries.
    expect(fenceClaim).toContain('UPDATE event_cover_workflow_fences');
    expect(fenceClaim).toContain('changes() = 1');
    expect(fenceClaim).toContain('SELECT j.dispatch_generation');
    expect(fenceClaim).toContain("expires_at = '9999-12-31T23:59:59.999Z'");
    expect(cleanup).toContain('DELETE FROM event_cover_workflow_fences');
    expect(cleanup).toContain("j.dispatch_state = 'pending'");
    expect(cleanup).toContain('j.dispatch_generation = 0');
    expect(cleanup).toContain(`created_at = '${NOW}'`);
  });

  it('stamps the job and fence when D1 applies the claim, not when the artifact was built', () => {
    const database = migratedDatabase();
    try {
      const candidate = seedDispatchCandidate(database);
      const batch = buildDispatchBatch({
        runId: RUN,
        rows: [candidate],
        nonterminal: 0,
        activeRuns: 0,
        minuteClaims: 0,
        latestClaimAt: null,
        now: NOW,
      });

      database.exec(batch.claimStatements.join('\n'));

      const job = database.prepare(`
        SELECT updated_at FROM event_cover_backfill_jobs WHERE id = ?
      `).get(JOB) as { updated_at: string };
      const fence = database.prepare(`
        SELECT updated_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
      `).get(candidate.workflowInstanceId) as { updated_at: string };
      expect(job.updated_at).not.toBe(NOW);
      expect(fence.updated_at).not.toBe(NOW);
      expect(job.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      expect(Math.abs(Date.parse(job.updated_at) - Date.parse(fence.updated_at)))
        .toBeLessThan(1_000);
    } finally {
      database.close();
    }
  });

  it('carries the run authorization and all capacity refusals into the statement itself', () => {
    const job = one().claimStatements[1]!;
    expect(job).toContain("r.mode = 'execute'");
    expect(job).toContain("r.status = 'executing'");
    // Another run is active.
    expect(job).toContain("r.status IN ('inventorying', 'executing')");
    // In-flight headroom is zero — counted over live dispatch states, never over
    // every queued row.
    expect(job).toContain(`j.dispatch_state IN (${LIVE_DISPATCH_STATES.map((s) => `'${s}'`).join(', ')})`);
    expect(job).toContain(`) < ${MAX_COVER_BACKFILL_IN_FLIGHT}`);
    // This same job was claimed inside the last minute.
    expect(job).toContain(dispatchRow(1).workflowInstanceId);
    // Twenty-five fences were claimed inside the rolling minute.
    expect(job).toContain(`) < ${MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE}`);
    expect(job).toContain("'-60 seconds'");
    // And the two the event owns: not deleted, not being purged.
    expect(job).toContain('deleted_at IS NULL');
    expect(job).toContain('event_cover_purge_progress');
  });

  it('refuses a claim after its run stops executing and removes its proposed fence', () => {
    const database = migratedDatabase();
    try {
      const candidate = seedDispatchCandidate(database);
      expect(dispatchRows(database)).toHaveLength(1);
      const batch = buildDispatchBatch({
        runId: RUN,
        rows: [candidate],
        nonterminal: 0,
        activeRuns: 0,
        minuteClaims: 0,
        latestClaimAt: null,
        now: NOW,
      });

      database.prepare("UPDATE event_cover_backfill_runs SET status = 'verified' WHERE id = ?")
        .run(RUN);
      database.exec(batch.claimStatements.join('\n'));

      expect(database.prepare(`
        SELECT dispatch_state, dispatch_generation
        FROM event_cover_backfill_jobs WHERE id = ?
      `).get(JOB)).toEqual({ dispatch_state: 'pending', dispatch_generation: 0 });
      expect(database.prepare(`
        SELECT count(*) AS value FROM event_cover_workflow_fences
        WHERE workflow_instance_id = ?
      `).get(candidate.workflowInstanceId)).toEqual({ value: 0 });
    } finally {
      database.close();
    }
  });

  it('refuses a stale claim after rolling capacity fills and leaves no generation-zero fence', () => {
    const database = migratedDatabase();
    try {
      const candidate = seedDispatchCandidate(database);
      expect(dispatchRows(database)).toHaveLength(1);
      const batch = buildDispatchBatch({
        runId: RUN,
        rows: [candidate],
        nonterminal: 0,
        activeRuns: 0,
        minuteClaims: 0,
        latestClaimAt: null,
        now: NOW,
      });

      for (let index = 0; index < MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE; index += 1) {
        database.prepare(`
          INSERT INTO event_cover_workflow_fences (
            workflow_binding, workflow_instance_id, event_id, dispatch_generation,
            state, created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, 1, 'open', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
        `).run(
          COVER_BACKFILL_BINDING,
          `cb1-${`${index + 100}`.padStart(48, '0')}`,
          EVENT,
          NOW,
          '9999-12-31T23:59:59.999Z',
        );
      }
      database.exec(batch.claimStatements.join('\n'));

      expect(database.prepare(`
        SELECT dispatch_state, dispatch_generation
        FROM event_cover_backfill_jobs WHERE id = ?
      `).get(JOB)).toEqual({ dispatch_state: 'pending', dispatch_generation: 0 });
      expect(database.prepare(`
        SELECT count(*) AS value FROM event_cover_workflow_fences
        WHERE workflow_instance_id = ?
      `).get(candidate.workflowInstanceId)).toEqual({ value: 0 });
    } finally {
      database.close();
    }
  });

  it('refuses a stale claim after in-flight capacity fills and leaves no proposed fence', () => {
    const database = migratedDatabase();
    try {
      const candidate = seedDispatchCandidate(database);
      expect(dispatchRows(database)).toHaveLength(1);
      const batch = buildDispatchBatch({
        runId: RUN,
        rows: [candidate],
        nonterminal: 0,
        activeRuns: 0,
        minuteClaims: 0,
        latestClaimAt: null,
        now: NOW,
      });

      fillInFlightCapacity(database);
      database.exec(batch.claimStatements.join('\n'));

      expect(database.prepare(`
        SELECT dispatch_state, dispatch_generation
        FROM event_cover_backfill_jobs WHERE id = ?
      `).get(JOB)).toEqual({ dispatch_state: 'pending', dispatch_generation: 0 });
      expect(database.prepare(`
        SELECT count(*) AS value FROM event_cover_workflow_fences
        WHERE workflow_instance_id = ?
      `).get(candidate.workflowInstanceId)).toEqual({ value: 0 });
    } finally {
      database.close();
    }
  });

  it('never cleans up a pre-existing generation-zero fence after a refused claim', () => {
    const database = migratedDatabase();
    try {
      const candidate = seedDispatchCandidate(database);
      database.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, 0, 'open', ?, ?, ?)
      `).run(
        COVER_BACKFILL_BINDING,
        candidate.workflowInstanceId,
        EVENT,
        NOW,
        NOW,
        '9999-12-31T23:59:59.999Z',
      );
      const observed = { ...candidate, fenceState: 'open' as const, fenceGeneration: 0 };
      const batch = buildDispatchBatch({
        runId: RUN,
        rows: [observed],
        nonterminal: 0,
        activeRuns: 0,
        minuteClaims: 0,
        latestClaimAt: null,
        now: NOW,
      });
      database.prepare("UPDATE event_cover_backfill_runs SET status = 'verified' WHERE id = ?")
        .run(RUN);

      database.exec(batch.claimStatements.join('\n'));

      expect(database.prepare(`
        SELECT state, dispatch_generation, created_at, updated_at
        FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
      `).get(candidate.workflowInstanceId)).toEqual({
        state: 'open',
        dispatch_generation: 0,
        created_at: NOW,
        updated_at: NOW,
      });
    } finally {
      database.close();
    }
  });

  it('does not mistake a concurrently inserted fence for its absent-at-read proposal', () => {
    const database = migratedDatabase();
    try {
      const candidate = seedDispatchCandidate(database);
      const batch = buildDispatchBatch({
        runId: RUN,
        rows: [candidate],
        nonterminal: 0,
        activeRuns: 0,
        minuteClaims: 0,
        latestClaimAt: null,
        now: NOW,
      });
      database.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, 0, 'open', ?, ?, ?)
      `).run(
        COVER_BACKFILL_BINDING,
        candidate.workflowInstanceId,
        EVENT,
        NOW,
        NOW,
        '9999-12-31T23:59:59.999Z',
      );
      database.prepare("UPDATE event_cover_backfill_runs SET status = 'verified' WHERE id = ?")
        .run(RUN);

      database.exec(batch.claimStatements.join('\n'));

      expect(database.prepare(`
        SELECT state, dispatch_generation, created_at, updated_at
        FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
      `).get(candidate.workflowInstanceId)).toEqual({
        state: 'open',
        dispatch_generation: 0,
        created_at: NOW,
        updated_at: NOW,
      });
    } finally {
      database.close();
    }
  });

  it('cleans its proposed fence when the old pending job changes status before claim', () => {
    const database = migratedDatabase();
    try {
      const candidate = seedDispatchCandidate(database);
      const batch = buildDispatchBatch({
        runId: RUN,
        rows: [candidate],
        nonterminal: 0,
        activeRuns: 0,
        minuteClaims: 0,
        latestClaimAt: null,
        now: NOW,
      });
      database.prepare(`
        UPDATE event_cover_backfill_jobs SET status = 'failed', retryable = 1 WHERE id = ?
      `).run(JOB);

      database.exec(batch.claimStatements.join('\n'));

      expect(database.prepare(`
        SELECT count(*) AS value FROM event_cover_workflow_fences
        WHERE workflow_instance_id = ?
      `).get(candidate.workflowInstanceId)).toEqual({ value: 0 });
    } finally {
      database.close();
    }
  });

  /**
   * The bound that matters is the one that holds between invocations. A batch
   * that claims its twenty-five and then reads D1 again must find itself full,
   * not merely decline to exceed itself inside a single call.
   */
  it('holds the in-flight and rolling-minute bounds across two invocations', () => {
    const rows = Array.from({ length: 40 }, (_unused, index) => dispatchRow(index));
    const first = buildDispatchBatch({
      runId: RUN, rows, nonterminal: 0, activeRuns: 0, minuteClaims: 0, latestClaimAt: null, now: NOW,
    });
    expect(first.create).toHaveLength(MAX_COVER_BACKFILL_CREATE_BATCH);

    // What D1 now reports: those claims are live and were made this minute.
    const second = buildDispatchBatch({
      runId: RUN,
      rows: rows.slice(first.create.length),
      nonterminal: first.create.length,
      activeRuns: 0,
      minuteClaims: first.create.length,
      latestClaimAt: NOW,
      now: '2026-08-05T10:00:30.000Z',
    });
    expect(second.create).toEqual([]);
    expect(second.notBefore).toBe('2026-08-05T10:01:00.000Z');

    // A minute later the rolling window has emptied, but the in-flight ceiling
    // has not: those instances are still running.
    const third = buildDispatchBatch({
      runId: RUN,
      rows: rows.slice(first.create.length),
      nonterminal: first.create.length,
      activeRuns: 0,
      minuteClaims: 0,
      latestClaimAt: NOW,
      now: '2026-08-05T10:01:30.000Z',
    });
    expect(third.create).toEqual([]);
    expect(third.limitingBound).toBe('in-flight');
  });

  it('counts only live dispatch states as in flight', () => {
    const sql = dispatchSql(RUN);
    // A run whose jobs are all still `pending` has nothing in flight; counting
    // them would make any run longer than one batch refuse its own first
    // dispatch and never recover.
    expect(sql).toContain(`j.dispatch_state IN (${LIVE_DISPATCH_STATES.map((s) => `'${s}'`).join(', ')})`
      .replace('j.dispatch_state', 'dispatch_state'));
    expect(LIVE_DISPATCH_STATES).not.toContain('pending');
  });
});

describe('the two-stage dispatch and launch protocol', () => {
  const outputRoot = resolve(process.cwd(), 'output');
  const dispatchPayloadFile = 'output/task-3-dispatch-payload.json';
  const claimFile = 'output/task-3-claim.json';
  const claimSqlFile = 'output/task-3-claim.sql';
  const claimedPayloadFile = 'output/task-3-claimed-payload.json';
  const launchFile = 'output/task-3-launch.json';
  const first = dispatchRow(21);
  const second = dispatchRow(22);

  const writeJson = (path: string, value: unknown) => {
    writeFileSync(resolve(process.cwd(), path), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  };

  const createClaimArtifact = (): Record<string, unknown> => {
    writeJson(dispatchPayloadFile, dispatchPayload([first, second]));
    const code = runCli([
      'dispatch',
      '--run-id', RUN,
      '--payload-file', dispatchPayloadFile,
      '--plan-file', claimFile,
      '--account-id', 'task-3-account',
      '--now', NOW,
    ], { CANDIDARY_COVER_BACKFILL_CONFIRM: '1' }, () => undefined);
    expect(code).toBe(0);
    return JSON.parse(readFileSync(resolve(process.cwd(), claimFile), 'utf8')) as Record<string, unknown>;
  };

  beforeAll(() => {
    mkdirSync(outputRoot, { recursive: true });
  });
  afterAll(() => {
    for (const path of [
      dispatchPayloadFile, claimFile, claimSqlFile, claimedPayloadFile, launchFile,
    ]) rmSync(resolve(process.cwd(), path), { force: true });
  });

  it('exports an exact post-claim read that represents accepted and refused candidates', () => {
    const database = migratedDatabase();
    try {
      const accepted = seedDispatchCandidate(database);
      const batch = buildDispatchBatch({
        runId: RUN,
        rows: [accepted],
        nonterminal: 0,
        activeRuns: 0,
        minuteClaims: 0,
        latestClaimAt: null,
        now: NOW,
      });
      database.exec(batch.claimStatements.join('\n'));
      const results = database.prepare(claimedDispatchSql(RUN, [accepted])).all() as Array<
        Record<string, unknown>
      >;
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'claim-result',
        candidate_job_id: accepted.jobId,
        candidate_dispatch_generation: 1,
        claim_accepted: 1,
        dispatch_state: 'creating',
        dispatch_generation: 1,
        fence_state: 'open',
        fence_generation: 1,
        run_mode: 'execute',
        run_status: 'executing',
      });

      database.prepare("UPDATE event_cover_backfill_runs SET status = 'verified' WHERE id = ?")
        .run(RUN);
      const refused = database.prepare(claimedDispatchSql(RUN, [accepted])).all() as Array<
        Record<string, unknown>
      >;
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        kind: 'claim-result',
        candidate_job_id: accepted.jobId,
        claim_accepted: 0,
        run_mode: 'execute',
        run_status: 'verified',
      });
    } finally {
      database.close();
    }
  });

  it('writes claim and post-claim-read steps with an exact manifest and zero triggers', () => {
    const artifact = createClaimArtifact();
    expect(artifact['candidates']).toEqual([claimCandidate(first), claimCandidate(second)]);
    const steps = artifact['steps'] as Array<Record<string, unknown>>;
    expect(steps.map((step) => step['kind'])).toEqual([
      'identity-check', 'identity-check', 'claim', 'claimed-read',
    ]);
    expect(JSON.stringify(artifact)).not.toContain('wrangler workflows trigger');
    expect(String(steps.at(-1)?.['command'])).toContain('claim-result');
    expect(String(steps.at(-1)?.['command'])).toContain(first.jobId);
    expect(String(steps.at(-1)?.['command'])).toContain(second.jobId);
  });

  it('launches exactly the accepted candidate and carries its confirm and receipt reads', () => {
    createClaimArtifact();
    writeJson(claimedPayloadFile, envelope([
      claimedWireRow(first, true),
      claimedWireRow(second, false),
    ]));
    const lines: string[] = [];
    const code = runCli([
      'launch',
      '--run-id', RUN,
      '--claim-file', claimFile,
      '--payload-file', claimedPayloadFile,
      '--plan-file', launchFile,
      '--account-id', 'task-3-account',
      '--now', NOW,
    ], { CANDIDARY_COVER_BACKFILL_CONFIRM: '1' }, (message) => lines.push(message));
    expect(code).toBe(0);

    const artifact = JSON.parse(readFileSync(resolve(process.cwd(), launchFile), 'utf8')) as {
      acceptedCandidates: unknown[];
      refusedCandidates: unknown[];
      steps: Array<Record<string, unknown>>;
    };
    expect(artifact.acceptedCandidates).toEqual([claimCandidate(first)]);
    expect(artifact.refusedCandidates).toEqual([claimCandidate(second)]);
    expect(artifact.steps.filter((step) => step['kind'] === 'trigger')).toHaveLength(1);
    expect(artifact.steps.filter((step) => step['kind'] === 'confirm-read')).toHaveLength(1);
    expect(artifact.steps.filter((step) => step['kind'] === 'receipt-read')).toHaveLength(1);
    const trigger = String(artifact.steps.find((step) => step['kind'] === 'trigger')?.['command']);
    expect(trigger).toContain(first.workflowInstanceId);
    expect(trigger).not.toContain(second.workflowInstanceId);
    expect(trigger).toContain(`--config ${WRANGLER_CONFIG_PATH}`);
    expect(trigger).not.toContain('--local');
    expect(trigger).not.toContain('--remote');
    expect(lines.join('\n')).not.toContain(second.workflowInstanceId);
  });

  it('rejects the whole launch before emitting a trigger for incomplete or hostile claim evidence', () => {
    createClaimArtifact();
    const unknown = dispatchRow(23);
    const cases: Array<[string, unknown[]]> = [
      ['missing candidate', [claimedWireRow(first, true)]],
      ['duplicate candidate', [claimedWireRow(first, true), claimedWireRow(first, true), claimedWireRow(second, false)]],
      ['unknown candidate', [claimedWireRow(first, true), claimedWireRow(second, false), claimedWireRow(unknown, true)]],
      ['wrong run', [claimedWireRow(first, true, { run_id: OTHER_RUN }), claimedWireRow(second, false)]],
      ['wrong generation', [claimedWireRow(first, true, { dispatch_generation: 2 }), claimedWireRow(second, false)]],
      ['wrong fence', [claimedWireRow(first, true, { fence_state: 'deletion-blocked' }), claimedWireRow(second, false)]],
      ['wrong status', [claimedWireRow(first, true, { status: 'rendering' }), claimedWireRow(second, false)]],
      ['wrong instance', [
        claimedWireRow(first, true, { workflow_instance_id: second.workflowInstanceId }),
        claimedWireRow(second, false),
      ]],
      ['partial missing job', [
        claimedWireRow(first, false, { job_id: null }),
        claimedWireRow(second, false),
      ]],
    ];

    for (const [label, rows] of cases) {
      rmSync(resolve(process.cwd(), launchFile), { force: true });
      writeJson(claimedPayloadFile, envelope(rows));
      const lines: string[] = [];
      let code: number | null = null;
      let failed = false;
      try {
        code = runCli([
          'launch',
          '--run-id', RUN,
          '--claim-file', claimFile,
          '--payload-file', claimedPayloadFile,
          '--plan-file', launchFile,
          '--account-id', 'task-3-account',
          '--now', NOW,
        ], { CANDIDARY_COVER_BACKFILL_CONFIRM: '1' }, (message) => lines.push(message));
      } catch {
        failed = true;
      }
      expect(failed || code === 1, label).toBe(true);
      expect(existsSync(resolve(process.cwd(), launchFile)), label).toBe(false);
      expect(lines.join('\n'), label).not.toContain('wrangler workflows trigger');
    }
  });

  it('rejects a claim artifact with the wrong run, resource identity, or protocol', () => {
    const original = createClaimArtifact();
    writeJson(claimedPayloadFile, envelope([
      claimedWireRow(first, true),
      claimedWireRow(second, false),
    ]));
    const identity = original['identity'] as Record<string, unknown>;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['wrong run', { ...original, runId: OTHER_RUN }],
      ['wrong account', { ...original, identity: { ...identity, accountId: 'another-account' } }],
      ['trigger-bearing claim', {
        ...original,
        steps: [
          ...(original['steps'] as unknown[]),
          { kind: 'trigger', command: 'npx wrangler workflows trigger hostile' },
        ],
      }],
    ];

    for (const [label, artifact] of cases) {
      rmSync(resolve(process.cwd(), launchFile), { force: true });
      writeJson(claimFile, artifact);
      const lines: string[] = [];
      let code: number | null = null;
      let failed = false;
      try {
        code = runCli([
          'launch',
          '--run-id', RUN,
          '--claim-file', claimFile,
          '--payload-file', claimedPayloadFile,
          '--plan-file', launchFile,
          '--account-id', 'task-3-account',
          '--now', NOW,
        ], { CANDIDARY_COVER_BACKFILL_CONFIRM: '1' }, (message) => lines.push(message));
      } catch {
        failed = true;
      }
      expect(failed || code === 1, label).toBe(true);
      expect(existsSync(resolve(process.cwd(), launchFile)), label).toBe(false);
      expect(lines.join('\n'), label).not.toContain('wrangler workflows trigger');
    }
  });
});

describe('the post-trigger confirmation', () => {
  it('reads one job and its fence together, and mutates nothing', () => {
    const sql = confirmSql({ runId: RUN, jobId: JOB, eventId: EVENT });
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/u);
    expect(sql).toContain(`j.id = '${JOB}'`);
    expect(sql).toContain(`j.run_id = '${RUN}'`);
    expect(sql).toContain(`j.event_id = '${EVENT}'`);
    expect(sql).toContain('LEFT JOIN event_cover_workflow_fences');
    expect(() => confirmSql({ runId: RUN, jobId: 'nope', eventId: EVENT })).toThrow(/UUID/u);
  });

  it('confirms only an open fence at the claimed generation', () => {
    const plan = evaluateConfirmation(parseConfirmPayload(envelope([confirmWireRow()])), expectation);
    expect(plan.outcome).toBe('confirm');
    expect(plan.commands).toEqual([]);
    const statement = plan.statements[0]!;
    expect(statement).toContain("dispatch_state = 'confirmed'");
    expect(statement).toContain("dispatch_state = 'creating'");
    expect(statement).toContain('dispatch_generation = 1');
    // Every emitted statement rechecks the fence, so a deletion that lands
    // between the read and the apply records no success.
    expect(statement).toContain("f.state = 'open'");
    expect(statement).toContain('f.dispatch_generation = 1');
    expect(statement).toContain('deleted_at IS NULL');
    // The fence claim timestamp is the durable dispatch clock and is not rewritten.
    expect(statement).not.toContain('UPDATE event_cover_workflow_fences');
  });

  it('emits the terminate and failure unit for a blocked fence, and no confirmation', () => {
    const plan = evaluateConfirmation(
      parseConfirmPayload(envelope([confirmWireRow({ fence_state: 'deletion-blocked' })])),
      expectation,
    );
    expect(plan.outcome).toBe('blocked');
    expect(plan.statements.join('\n')).not.toContain("dispatch_state = 'confirmed'");
    expect(plan.statements[0]).toContain("failure_code = 'EVENT_DELETED'");
    expect(plan.statements[0]).toContain("f.state = 'deletion-blocked'");
    expect(plan.commands[0]).toBe(
      `npx wrangler workflows instances terminate ${COVER_BACKFILL_WORKFLOW_NAME}`
      + ` cb1-${'0'.repeat(48)} --config ${WRANGLER_CONFIG_PATH}`,
    );
  });

  it('emits no success mutation for a stale, missing, or ambiguous read', () => {
    const cases: Array<[string, unknown]> = [
      ['generation moved on', envelope([confirmWireRow({ dispatch_generation: 2, fence_generation: 2 })])],
      ['fence already swept', envelope([confirmWireRow({ fence_state: null, fence_generation: null })])],
      ['job already terminal', envelope([confirmWireRow({ dispatch_state: 'failed', status: 'failed' })])],
      ['no row at all', envelope([])],
      ['two rows', envelope([confirmWireRow(), confirmWireRow()])],
    ];
    for (const [label, payload] of cases) {
      const plan = evaluateConfirmation(parseConfirmPayload(payload), expectation);
      expect(plan.outcome, label).not.toBe('confirm');
      expect(plan.statements, label).toEqual([]);
      expect(plan.commands, label).toEqual([]);
      expect(plan.reasons.length, label).toBeGreaterThan(0);
    }
  });

  /**
   * The parity that matters. The operator's statement and the Worker's are the
   * same predicates because there is exactly one place they are written, so a
   * guard removed from the shared builder disappears from both sides at once and
   * neither can quietly become the weaker contract.
   */
  it('emits exactly the shared predicates the Worker binds', () => {
    const literals = {
      binding: `'${COVER_BACKFILL_BINDING}'`,
      runId: `'${RUN}'`,
      jobId: `'${JOB}'`,
      eventId: `'${EVENT}'`,
      generation: '1',
      now: `'${NOW}'`,
    };
    const confirmed = evaluateConfirmation(
      parseConfirmPayload(envelope([confirmWireRow()])), expectation,
    );
    expect(confirmed.statements[0]).toBe(`${confirmCoverBackfillDispatchSql(literals)};`);

    const blocked = evaluateConfirmation(
      parseConfirmPayload(envelope([confirmWireRow({ fence_state: 'deletion-blocked' })])),
      expectation,
    );
    expect(blocked.statements[0]).toBe(`${blockCoverBackfillDispatchSql(literals)};`);

    for (const clause of [
      "dispatch_state = 'creating'", 'dispatch_generation = 1',
      "f.state = 'open'", 'f.dispatch_generation = 1', 'deleted_at IS NULL',
    ]) expect(confirmCoverBackfillDispatchSql(literals)).toContain(clause);
    for (const clause of [
      "failure_code = 'EVENT_DELETED'", "f.state = 'deletion-blocked'", 'retryable = 0',
    ]) expect(blockCoverBackfillDispatchSql(literals)).toContain(clause);
  });

  it('refuses a read that is not the job the operator claimed', () => {
    const plan = evaluateConfirmation(
      parseConfirmPayload(envelope([confirmWireRow({ event_id: OTHER_EVENT })])),
      expectation,
    );
    expect(plan.outcome).toBe('unusable');
    expect(plan.statements).toEqual([]);
  });

  /** Replaying the same confirmation is a guarded no-op, never a second write. */
  it('treats an already-confirmed job as a replay', () => {
    const plan = evaluateConfirmation(
      parseConfirmPayload(envelope([confirmWireRow({ dispatch_state: 'confirmed' })])),
      expectation,
    );
    expect(plan.outcome).toBe('confirm');
    expect(plan.reasons.join(' ')).toMatch(/replay/u);
    expect(plan.statements[0]).toContain("dispatch_state = 'creating'");
  });
});

describe('the run-state read', () => {
  it('reads exactly one run and mutates nothing', () => {
    const sql = runStateSql(RUN);
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/u);
    expect(sql).toContain(`id = '${RUN}'`);
    expect(parseRunStatePayload(envelope([{
      kind: 'run', run_id: RUN, mode: 'inventory', status: 'inventorying',
      cursor: EVENT, inventory_sha256: 'b'.repeat(64),
    }]))).toEqual(runState());
    expect(() => parseRunStatePayload(envelope([]))).toThrow(/run state/u);
    expect(() => parseRunStatePayload(envelope([
      { kind: 'run', run_id: RUN, mode: 'inventory', status: 'nonsense', cursor: null, inventory_sha256: null },
    ]))).toThrow(/status/u);
  });
});

describe('the verification run', () => {
  it('creates an executing verify run and can never record verified', () => {
    const statement = verificationRunStatement({ runId: RUN, now: NOW });
    expect(statement).toContain('INSERT INTO event_cover_backfill_runs');
    expect(statement).toContain("'verify'");
    expect(statement).toContain("'executing'");
    expect(statement).not.toContain("'verified'");
    expect(statement).not.toContain('verified_at');
  });
});

describe('the zero-legacy proof', () => {
  const counts = (values: Record<string, number>) => envelope(
    Object.entries(values).map(([name, value]) => ({ name, value })),
  );

  it('is green only when all four counts are present and zero', () => {
    expect(evaluateZeroLegacyProof(counts({
      legacyRows: 0, blockingJobs: 0, incompleteActiveSets: 0, uploadsWithoutActiveSet: 0,
    })).proven).toBe(true);
  });

  it('renders the shared canonical proof query exactly once', () => {
    expect(proofSql()).toBe(`${zeroLegacyProofRowsSql()};`);
    for (const name of ZERO_LEGACY_PROOF_NAMES) {
      expect(proofSql().match(new RegExp(`'${name}'`, 'gu'))).toHaveLength(1);
    }
  });

  it('treats a missing count as an issue rather than a zero', () => {
    const evaluation = evaluateZeroLegacyProof(counts({
      legacyRows: 0, blockingJobs: 0, incompleteActiveSets: 0,
    }));
    expect(evaluation.proven).toBe(false);
    expect(evaluation.issues).toContain('uploadsWithoutActiveSet is missing from the proof payload.');
  });

  it('names each nonzero count', () => {
    const evaluation = evaluateZeroLegacyProof(counts({
      legacyRows: 4, blockingJobs: 1, incompleteActiveSets: 0, uploadsWithoutActiveSet: 0,
    }));
    expect(evaluation.proven).toBe(false);
    expect(evaluation.issues).toEqual(['legacyRows is 4.', 'blockingJobs is 1.']);
  });

  it.each([
    ['duplicate', [
      { name: 'legacyRows', value: 0 }, { name: 'legacyRows', value: 0 },
      { name: 'blockingJobs', value: 0 }, { name: 'incompleteActiveSets', value: 0 },
      { name: 'uploadsWithoutActiveSet', value: 0 },
    ]],
    ['negative', [
      { name: 'legacyRows', value: -1 }, { name: 'blockingJobs', value: 0 },
      { name: 'incompleteActiveSets', value: 0 }, { name: 'uploadsWithoutActiveSet', value: 0 },
    ]],
    ['noninteger', [
      { name: 'legacyRows', value: 0.5 }, { name: 'blockingJobs', value: 0 },
      { name: 'incompleteActiveSets', value: 0 }, { name: 'uploadsWithoutActiveSet', value: 0 },
    ]],
    ['unknown', [
      { name: 'legacyRows', value: 0 }, { name: 'blockingJobs', value: 0 },
      { name: 'incompleteActiveSets', value: 0 }, { name: 'uploadsWithoutActiveSet', value: 0 },
      { name: 'surprise', value: 0 },
    ]],
  ] as const)('treats a %s proof row as red display evidence', (_name, rows) => {
    const evaluation = evaluateZeroLegacyProof(envelope(rows));
    expect(evaluation.proven).toBe(false);
    expect(evaluation.issues.length).toBeGreaterThan(0);
  });

  it('rejects more than one result set even when the first is green', () => {
    const rows = [
      { name: 'legacyRows', value: 0 }, { name: 'blockingJobs', value: 0 },
      { name: 'incompleteActiveSets', value: 0 }, { name: 'uploadsWithoutActiveSet', value: 0 },
    ];
    expect(evaluateZeroLegacyProof([
      { results: rows }, { results: [] },
    ])).toMatchObject({ proven: false });
  });
});

describe('the command line', () => {
  it('accepts the six planner modes and nothing else', () => {
    expect(parseCoverBackfillArgs([]).mode).toBe('inventory');
    for (const mode of ['inventory', 'execute', 'dispatch', 'launch', 'confirm', 'verify'] as const) {
      expect(parseCoverBackfillArgs([mode]).mode).toBe(mode);
    }
    expect(() => parseCoverBackfillArgs(['apply'])).toThrow(/Unknown mode/u);
    expect(() => parseCoverBackfillArgs(['inventory', '--force'])).toThrow(/Unknown argument/u);
    expect(() => parseCoverBackfillArgs(['inventory', '--payload-file'])).toThrow(/needs a value/u);
    expect(parseCoverBackfillArgs(['confirm', '--generation', '3']).generation).toBe(3);
    expect(() => parseCoverBackfillArgs(['confirm', '--generation', 'two']))
      .toThrow(/generation/u);
  });

  it('reads the confirmation from the environment, never from a flag', () => {
    expect(parseCoverBackfillArgs(['execute'], {}).confirmed).toBe(false);
    expect(parseCoverBackfillArgs(['execute'], { CANDIDARY_COVER_BACKFILL_CONFIRM: '1' }).confirmed)
      .toBe(true);
  });

  it('prints the statement to run when no payload has been supplied yet', () => {
    const lines: string[] = [];
    expect(runCli(['inventory'], {}, (message) => lines.push(message))).toBe(0);
    expect(lines.join('\n')).toContain('cover_render_set_id IS NULL');
    expect(lines.join('\n')).toContain('wrangler d1 execute');
    expect(lines.join('\n')).toContain('--remote');
  });

  it('emits nothing mutating in verify mode without the confirmation', () => {
    const lines: string[] = [];
    expect(runCli(['verify'], {}, (message) => lines.push(message))).toBe(0);
    expect(lines.join('\n')).toContain('legacyRows');
    expect(lines.join('\n')).not.toContain('INSERT');
  });

  it('lets a saved green payload open only an executing run while current D1 can turn red', () => {
    const payloadFile = resolve(process.cwd(), 'output/cover-backfill-green-proof.json');
    mkdirSync(resolve(process.cwd(), 'output'), { recursive: true });
    writeFileSync(payloadFile, JSON.stringify(envelope([
      { name: 'legacyRows', value: 0 },
      { name: 'blockingJobs', value: 0 },
      { name: 'incompleteActiveSets', value: 0 },
      { name: 'uploadsWithoutActiveSet', value: 0 },
    ])));
    try {
      const lines: string[] = [];
      expect(runCli(
        ['verify', '--payload-file', 'output/cover-backfill-green-proof.json', '--run-id', RUN, '--now', NOW],
        { CANDIDARY_COVER_BACKFILL_CONFIRM: '1' },
        (message) => lines.push(message),
      )).toBe(0);
      const output = lines.join('\n');
      expect(output).toContain("'verify', 'executing'");
      expect(output).not.toMatch(/UPDATE[\s\S]*status\s*=\s*'verified'/u);
      expect(output).not.toContain('verified_at');

      const database = migratedDatabase();
      try {
        database.exec(verificationRunStatement({ runId: RUN, now: NOW }));
        database.prepare(`
          INSERT INTO events (
            id, slug, name, event_date, welcome_message, cover_object_key,
            guest_access_expires_at, management_access_expires_at, purge_after, created_at
          ) VALUES (?, 'proof-race', 'Proof race', '2026-08-08', 'Welcome', ?, ?, ?, ?, ?)
        `).run(EVENT, 'events/proof-race/cover/legacy.jpg', NOW, NOW, NOW, NOW);
        expect(database.prepare(zeroLegacyProofRowsSql()).all()).toContainEqual({
          name: 'legacyRows', value: 1,
        });
        expect(database.prepare(`
          SELECT status, verified_at FROM event_cover_backfill_runs WHERE id = ?
        `).get(RUN)).toEqual({ status: 'executing', verified_at: null });
      } finally {
        database.close();
      }
    } finally {
      rmSync(payloadFile, { force: true });
    }
  });

  it('prints the durable dispatch read before it will plan anything', () => {
    const lines: string[] = [];
    expect(runCli(['dispatch', '--run-id', RUN], {}, (message) => lines.push(message))).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain("'dispatchable' AS kind");
    expect(text).not.toContain('wrangler workflows trigger');
  });

  it('requires a run id for dispatch and confirm', () => {
    const lines: string[] = [];
    expect(runCli(['dispatch'], {}, (message) => lines.push(message))).toBe(1);
    expect(runCli(['confirm'], {}, (message) => lines.push(message))).toBe(1);
    expect(lines.join('\n')).toContain('--run-id');
  });
});

describe('artifacts stay inside the ignored output directory', () => {
  const outputRoot = resolve(process.cwd(), 'output');
  const planFile = 'output/cover-backfill-test-plan.json';
  const sqlFile = resolve(process.cwd(), 'output/cover-backfill-test-plan.sql');

  beforeAll(() => {
    mkdirSync(outputRoot, { recursive: true });
  });
  afterAll(() => {
    rmSync(resolve(process.cwd(), planFile), { force: true });
    rmSync(sqlFile, { force: true });
  });

  it('refuses to write a plan anywhere else in the repository', () => {
    const lines: string[] = [];
    const code = runCli(
      ['dispatch', '--run-id', RUN, '--payload-file', 'output/missing.json', '--plan-file', 'docs/leak.json'],
      { CANDIDARY_COVER_BACKFILL_CONFIRM: '1' },
      (message) => lines.push(message),
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('output');
    expect(existsSync(resolve(process.cwd(), 'docs/leak.json'))).toBe(false);
  });
});

describe('the operator commands are checked in', () => {
  it('exposes the six modes as npm scripts', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    for (const mode of ['inventory', 'execute', 'dispatch', 'launch', 'confirm', 'verify']) {
      expect(packageJson.scripts?.[`cover-backfill:${mode}`])
        .toBe(`node --experimental-strip-types scripts/cover-backfill.ts ${mode}`);
    }
    expect(existsSync(resolve(process.cwd(), 'scripts/cover-backfill.ts'))).toBe(true);
  });
});

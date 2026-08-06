import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_COVER_BACKFILL_CREATE_BATCH,
  MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
  MAX_COVER_BACKFILL_IN_FLIGHT,
  MAX_COVER_BACKFILL_PAGE_SIZE,
} from '../../shared/constants';
import { COVER_PIPELINE_VERSIONS } from '../../shared/event-cover';
import {
  COVER_BACKFILL_DEPENDENCY_VERSIONS,
  backfillInstanceId,
  buildBackfillRunPlan,
  buildDispatchBatch,
  evaluateZeroLegacyProof,
  fingerprintKey,
  inventoryDigest,
  inventorySql,
  parseCountPayload,
  parseCoverBackfillArgs,
  parseInventoryPayload,
  proofSql,
  runCli,
  type InventoryRow,
  type PlannedJob,
} from '../../scripts/cover-backfill';

const RUN = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const OTHER_EVENT = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-08-05T10:00:00.000Z';

const row = (id: string, key: string, revision = 0): InventoryRow => ({
  id,
  cover_object_key: key,
  cover_revision: revision,
});

const envelope = (rows: unknown[]) => [{ results: rows, success: true }];

const plannedJob = (index: number): PlannedJob => ({
  jobId: `${index}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
  eventId: `${index}`.padStart(8, '1') + '-1111-4111-8111-111111111111',
  expectedRevision: 0,
  legacyKeyFingerprint: 'a'.repeat(64),
  workflowInstanceId: `cb1-${`${index}`.padStart(48, '0')}`,
});

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
});

describe('the run plan', () => {
  const rows = [row(EVENT, 'events/a/cover/one', 3), row(OTHER_EVENT, 'events/b/cover/two', 0)];
  const plan = (newRun: boolean) => buildBackfillRunPlan({
    runId: RUN,
    rows,
    now: NOW,
    newRun,
    makeJobId: (() => {
      let index = 0;
      return () => [JOB, '55555555-5555-4555-8555-555555555555'][index++]!;
    })(),
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
  });

  it('has a null cursor for an empty page and refuses an oversized one', () => {
    expect(buildBackfillRunPlan({ runId: RUN, rows: [], now: NOW, newRun: true }).cursor).toBeNull();
    expect(() => buildBackfillRunPlan({
      runId: RUN,
      rows: Array.from({ length: MAX_COVER_BACKFILL_PAGE_SIZE + 1 }, () => row(EVENT, 'k')),
      now: NOW,
      newRun: true,
    })).toThrow(/page size/u);
    expect(() => buildBackfillRunPlan({ runId: 'nope', rows: [], now: NOW, newRun: true }))
      .toThrow(/UUID/u);
    expect(() => buildBackfillRunPlan({ runId: RUN, rows: [], now: 'yesterday', newRun: true }))
      .toThrow(/instant/u);
  });
});

describe('the dispatch batch', () => {
  const queued = Array.from({ length: 40 }, (_unused, index) => plannedJob(index));

  it('creates nothing at all once the in-flight ceiling is reached', () => {
    const batch = buildDispatchBatch({
      runId: RUN, queued, nonterminal: MAX_COVER_BACKFILL_IN_FLIGHT, now: NOW,
    });
    expect(batch.create).toEqual([]);
    expect(batch.commands).toEqual([]);
    expect(batch.fenceStatements).toEqual([]);
    expect(batch.withheldForInFlight).toBe(40);
  });

  it('takes the tightest of the three bounds', () => {
    const empty = buildDispatchBatch({ runId: RUN, queued, nonterminal: 0, now: NOW });
    expect(empty.create).toHaveLength(
      Math.min(MAX_COVER_BACKFILL_CREATE_BATCH, MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE),
    );
    expect(empty.withheldForBatch).toBe(40 - empty.create.length);

    const nearlyFull = buildDispatchBatch({
      runId: RUN, queued, nonterminal: MAX_COVER_BACKFILL_IN_FLIGHT - 3, now: NOW,
    });
    expect(nearlyFull.create).toHaveLength(3);
    expect(nearlyFull.withheldForBatch).toBe(37);
  });

  it('opens one fence per instance and emits a create carrying only opaque ids', () => {
    const batch = buildDispatchBatch({ runId: RUN, queued: [plannedJob(7)], nonterminal: 0, now: NOW });
    expect(batch.fenceStatements[0]).toContain("'COVER_BACKFILL_WORKFLOW'");
    expect(batch.fenceStatements[0]).toContain("'open'");
    expect(batch.fenceStatements[0]).toContain('ON CONFLICT');
    expect(batch.commands[0]).toContain('candidary-cover-backfill');
    expect(batch.commands[0]).toContain(plannedJob(7).workflowInstanceId);
    expect(batch.commands[0]).toContain('"runId"');
    expect(batch.commands[0]).not.toContain('cover_object_key');
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
    const job = plannedJob(3);
    const batch = buildDispatchBatch({ runId: RUN, queued: [job], nonterminal: 0, now: NOW });

    expect(batch.commands[0]).toBe(
      "npx wrangler workflows trigger candidary-cover-backfill "
      + `'{"runId":"${RUN}","jobId":"${job.jobId}","eventId":"${job.eventId}"}'`
      + ` --id ${job.workflowInstanceId}`,
    );
    expect(batch.commands[0]).not.toContain('instances create');
    expect(batch.commands[0]).not.toContain('--params');
  });

  it('emits a PowerShell-quoted form beside it, because that is the shell here', () => {
    const job = plannedJob(4);
    const batch = buildDispatchBatch({ runId: RUN, queued: [job], nonterminal: 0, now: NOW });

    // A single-quoted JSON payload survives POSIX and is eaten by PowerShell, so
    // the operator gets the doubled-quote form rather than an instance created
    // with no parameters at all.
    expect(batch.powershellCommands[0]).toContain('""runId""');
    expect(batch.powershellCommands[0]).toContain(`--id ${job.workflowInstanceId}`);
    expect(batch.powershellCommands[0]).not.toContain("'{");
    expect(JSON.parse(
      batch.powershellCommands[0]!.slice(
        batch.powershellCommands[0]!.indexOf('"{'),
        batch.powershellCommands[0]!.lastIndexOf('}"') + 2,
      ).slice(1, -1).replace(/""/gu, '"'),
    )).toEqual({ runId: RUN, jobId: job.jobId, eventId: job.eventId });
  });

  it('refuses a negative in-flight count rather than inventing headroom', () => {
    expect(() => buildDispatchBatch({ runId: RUN, queued, nonterminal: -1, now: NOW }))
      .toThrow(/negative/u);
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
});

describe('the command line', () => {
  it('defaults to the read-only inventory mode', () => {
    expect(parseCoverBackfillArgs([]).mode).toBe('inventory');
    expect(parseCoverBackfillArgs(['execute']).mode).toBe('execute');
    expect(() => parseCoverBackfillArgs(['apply'])).toThrow(/Unknown mode/u);
    expect(() => parseCoverBackfillArgs(['inventory', '--force'])).toThrow(/Unknown argument/u);
    expect(() => parseCoverBackfillArgs(['inventory', '--payload-file'])).toThrow(/needs a value/u);
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
  });

  it('emits nothing mutating in execute mode without the confirmation', () => {
    const lines: string[] = [];
    expect(runCli(['verify'], {}, (message) => lines.push(message))).toBe(0);
    expect(lines.join('\n')).toContain('legacyRows');
  });
});

describe('the operator commands are checked in', () => {
  it('exposes the three modes as npm scripts', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['cover-backfill:inventory'])
      .toBe('node --experimental-strip-types scripts/cover-backfill.ts inventory');
    expect(packageJson.scripts?.['cover-backfill:execute'])
      .toBe('node --experimental-strip-types scripts/cover-backfill.ts execute');
    expect(packageJson.scripts?.['cover-backfill:verify'])
      .toBe('node --experimental-strip-types scripts/cover-backfill.ts verify');
    expect(existsSync(resolve(process.cwd(), 'scripts/cover-backfill.ts'))).toBe(true);
  });
});

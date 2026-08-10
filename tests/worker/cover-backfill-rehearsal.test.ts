import { beforeEach, describe, expect, it } from 'vitest';

import {
  COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
  MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
  MAX_COVER_BACKFILL_IN_FLIGHT,
} from '../../shared/constants';
import { claimCoverBackfillDispatchSql } from '../../shared/cover-dispatch';
import { EVENT_COVER_PROFILES } from '../../shared/event-cover';
import type { AppEnv } from '../../worker/env';
import { coverKeyFingerprint } from '../../worker/storage/event-cover-keys';
import {
  confirmCoverBackfillDispatch,
  coverBackfillDependencyVersions,
  coverBackfillFinalize,
  coverBackfillInstanceId,
  coverBackfillNormalize,
  coverBackfillPreflight,
  coverBackfillProfileStep,
  closeCoverBackfillRuns,
  proveZeroLegacyCovers,
  reconcileCoverBackfillJobs,
  recoverStaleInitialBackfillDispatches,
  resolveSupersededBackfillJobsBounded,
  type CoverBackfillPayload,
} from '../../worker/workflows/cover-backfill';
import type {
  CoverBackfillWorkflowAccessor,
  CoverWorkflowLookup,
} from '../../worker/workflows/cover-platform';
import {
  reconcileEventCoverPurge,
  type CoverPurgeWorkflowAccessors,
} from '../../worker/workflows/cleanup';
import {
  batchD1Statements,
  resetDatabaseToPhase2CoverSchema as resetDatabase,
  testEnv,
  withRecordingImages,
  withRecordingR2Puts,
} from './helpers';

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const START = new Date('2026-08-08T12:00:00.000Z');
const STALE = new Date('2026-08-08T11:55:00.000Z');
const PURGE_REENTRY = new Date('2026-08-08T12:05:00.000Z');
const HEX = 'a'.repeat(64);
const UPLOAD_CONFIG = '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}';

interface RehearsalEntry {
  index: number;
  eventId: string;
  jobId: string;
  key: string;
  instanceId: string;
  payload: CoverBackfillPayload;
}

interface RunCounters {
  total_count: number;
  queued_count: number;
  applied_count: number;
  skipped_count: number;
  resolved_count: number;
  failed_count: number;
  needs_replacement_count: number;
}

interface JobPins {
  id: string;
  workflow_instance_id: string;
  dispatch_generation: number;
  master_id: string | null;
  render_set_id: string | null;
  manifest_json: string | null;
  manifest_sha256: string | null;
}

function fixedId(prefix: '1' | '2', index: number): string {
  return `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function legacyKey(eventId: string): string {
  return `events/${eventId}/cover/legacy.jpg`;
}

async function row<T>(sql: string, ...values: unknown[]): Promise<T> {
  return (await testEnv.DB.prepare(sql).bind(...values).first<T>())!;
}

async function runCounters(): Promise<RunCounters> {
  return row<RunCounters>(`
    SELECT total_count, queued_count, applied_count, skipped_count, resolved_count,
      failed_count, needs_replacement_count
    FROM event_cover_backfill_runs WHERE id = ?
  `, RUN_ID);
}

async function jobPins(jobId: string): Promise<JobPins> {
  return row<JobPins>(`
    SELECT id, workflow_instance_id, dispatch_generation, master_id, render_set_id,
      manifest_json, manifest_sha256
    FROM event_cover_backfill_jobs WHERE id = ?
  `, jobId);
}

async function seedCompleteActiveCover(
  eventId: string,
  label: string,
  updateEvent = true,
): Promise<{ masterId: string; setId: string; masterKey: string }> {
  const masterId = `master-${label}`;
  const setId = `set-${label}`;
  const masterKey = `events/${eventId}/cover/masters/${masterId}.webp`;
  const createdAt = START.toISOString();
  const statements: D1PreparedStatement[] = [
    testEnv.DB.prepare(`
      INSERT INTO event_cover_masters (
        id, event_id, object_key, mime_type, byte_size, width, height, sha256,
        normalization_version, normalization_rung, auto_focus_x, auto_focus_y,
        composition_model_version, created_at
      ) VALUES (?, ?, ?, 'image/webp', 1000, 1200, 800, ?, 1, 1, 0.5, 0.5, 1, ?)
    `).bind(masterId, eventId, masterKey, HEX, createdAt),
    testEnv.DB.prepare(`
      INSERT INTO event_cover_render_sets (
        id, event_id, master_id, draft_id, recipe_json, recipe_sha256, state,
        required_slots, manifest_sha256, published_revision, created_at, ready_at, published_at
      ) VALUES (?, ?, ?, NULL, ?, ?, 'active', 12, ?, 1, ?, ?, ?)
    `).bind(setId, eventId, masterId, UPLOAD_CONFIG, HEX, HEX, createdAt, createdAt, createdAt),
  ];
  let objectIndex = 0;
  for (const profile of EVENT_COVER_PROFILES) {
    for (const format of ['webp', 'jpeg'] as const) {
      statements.push(testEnv.DB.prepare(`
        INSERT INTO event_cover_render_objects (
          id, render_set_id, event_id, profile_id, density, format, object_key,
          content_type, byte_size, width, height, quality_rung, sha256, created_at
        ) VALUES (?, ?, ?, ?, '1x', ?, ?, ?, 100, 360, 168, 1, ?, ?)
      `).bind(
        `object-${label}-${objectIndex++}`, setId, eventId, profile.id, format,
        `events/${eventId}/cover/rendered/${setId}/${profile.id}-1x.${format}`,
        format === 'webp' ? 'image/webp' : 'image/jpeg', HEX, createdAt,
      ));
    }
  }
  if (updateEvent) {
    statements.push(testEnv.DB.prepare(`
      UPDATE events SET cover_object_key = ?, cover_config = ?, cover_revision = cover_revision + 1,
        cover_render_set_id = ? WHERE id = ?
    `).bind(masterKey, UPLOAD_CONFIG, setId, eventId));
  }
  await batchD1Statements(testEnv.DB, statements);
  return { masterId, setId, masterKey };
}

async function seedManifestObjects(entry: RehearsalEntry): Promise<void> {
  const pins = await jobPins(entry.jobId);
  const slots = (JSON.parse(pins.manifest_json!) as {
    slots: Array<{ profile: string; density: string; format: string }>;
  }).slots;
  await batchD1Statements(testEnv.DB, slots.map((slot, index) => testEnv.DB.prepare(`
    INSERT INTO event_cover_render_objects (
      id, render_set_id, event_id, profile_id, density, format, object_key,
      content_type, byte_size, width, height, quality_rung, sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, 360, 168, 1, ?, ?)
  `).bind(
    `interrupted-${entry.index}-${index}`, pins.render_set_id, entry.eventId,
    slot.profile, slot.density, slot.format,
    `events/${entry.eventId}/cover/rendered/${pins.render_set_id}/${slot.profile}-${slot.density}.${slot.format}`,
    slot.format === 'webp' ? 'image/webp' : 'image/jpeg', HEX, START.toISOString(),
  )));
}

async function seedPopulatedInventory(): Promise<RehearsalEntry[]> {
  const entries: RehearsalEntry[] = [];
  for (let index = 0; index < 101; index += 1) {
    const eventId = fixedId('1', index);
    const jobId = fixedId('2', index);
    const instanceId = await coverBackfillInstanceId(RUN_ID, jobId, eventId);
    entries.push({
      index, eventId, jobId, instanceId, key: legacyKey(eventId),
      payload: { runId: RUN_ID, jobId, eventId },
    });
  }

  const timestamp = START.toISOString();
  const statements: D1PreparedStatement[] = [testEnv.DB.prepare(`
    INSERT INTO event_cover_backfill_runs (
      id, mode, inventory_sha256, total_count, queued_count, status, created_at, updated_at
    ) VALUES (?, 'execute', ?, 101, 101, 'executing', ?, ?)
  `).bind(RUN_ID, 'f'.repeat(64), timestamp, timestamp)];
  for (const entry of entries) {
    statements.push(testEnv.DB.prepare(`
      INSERT INTO events (
        id, slug, name, event_date, welcome_message, cover_object_key,
        guest_access_expires_at, management_access_expires_at, purge_after, created_at
      ) VALUES (?, ?, 'Rehearsal', '2026-09-19', 'Welcome.', ?, ?, ?, ?, ?)
    `).bind(
      entry.eventId, `rehearsal-${String(entry.index).padStart(3, '0')}`, entry.key,
      timestamp, timestamp, '2027-09-19T00:00:00.000Z', timestamp,
    ));
    statements.push(testEnv.DB.prepare(`
      INSERT INTO event_cover_backfill_jobs (
        id, run_id, event_id, expected_revision, legacy_key_fingerprint,
        workflow_instance_id, dispatch_state, dispatch_generation, status,
        dependency_versions_json, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, 'pending', 0, 'queued', ?, ?, ?)
    `).bind(
      entry.jobId, RUN_ID, entry.eventId, await coverKeyFingerprint(entry.key),
      entry.instanceId, JSON.stringify(coverBackfillDependencyVersions()), timestamp, timestamp,
    ));
  }
  await batchD1Statements(testEnv.DB, statements);

  const activeEventId = '30000000-0000-4000-8000-000000000000';
  await testEnv.DB.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message, guest_access_expires_at,
      management_access_expires_at, purge_after, created_at
    ) VALUES (?, 'rehearsal-active', 'Already active', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
  `).bind(activeEventId, timestamp, timestamp, '2027-09-19T00:00:00.000Z', timestamp).run();
  await seedCompleteActiveCover(activeEventId, 'already-active');

  for (const index of [0, 1, 2, 5, 9]) {
    await testEnv.MEDIA_BUCKET.put(entries[index]!.key, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
  }
  return entries;
}

async function inventoryPage(after: string | null): Promise<string[]> {
  const result = await testEnv.DB.prepare(`
    SELECT id FROM event_cover_backfill_jobs
    WHERE run_id = ? AND (? IS NULL OR id > ?)
    ORDER BY id LIMIT 100
  `).bind(RUN_ID, after, after).all<{ id: string }>();
  return result.results.map((candidate) => candidate.id);
}

async function claimBatch(entries: readonly RehearsalEntry[]): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const entry of entries) {
    statements.push(testEnv.DB.prepare(`
      INSERT INTO event_cover_workflow_fences (
        workflow_binding, workflow_instance_id, event_id, dispatch_generation,
        state, created_at, updated_at, expires_at
      ) VALUES ('COVER_BACKFILL_WORKFLOW', ?, ?, 0, 'open', ?, ?, ?)
    `).bind(
      entry.instanceId, entry.eventId, START.toISOString(), START.toISOString(),
      COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
    ));
    const claim = claimCoverBackfillDispatchSql({
      binding: '?1', runId: '?2', jobId: '?3', eventId: '?4', generation: '?5',
      now: '?6', workflowInstanceId: '?7',
    }, {
      inFlight: MAX_COVER_BACKFILL_IN_FLIGHT,
      perMinute: MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
    });
    const binds = [
      'COVER_BACKFILL_WORKFLOW', RUN_ID, entry.jobId, entry.eventId,
      0, START.toISOString(), entry.instanceId,
    ];
    statements.push(testEnv.DB.prepare(claim.job).bind(...binds));
    statements.push(testEnv.DB.prepare(claim.fence).bind(...binds));
  }
  const results = await batchD1Statements(testEnv.DB, statements);
  expect(results.filter((_, index) => index % 3 === 1).map((result) => result.meta.changes))
    .toEqual(entries.map(() => 1));
}

async function confirm(entry: RehearsalEntry): Promise<void> {
  expect(await confirmCoverBackfillDispatch(testEnv, {
    ...entry.payload, generation: 1, now: START,
  })).toBe('confirmed');
}

async function renderAll(env: AppEnv, entry: RehearsalEntry): Promise<void> {
  for (const profile of EVENT_COVER_PROFILES) {
    await coverBackfillProfileStep(env, entry.payload, profile.id, START);
  }
}

function blockingPurgeAccessors(calls: string[] = []): CoverPurgeWorkflowAccessors {
  const common = {
    async lookup(): Promise<CoverWorkflowLookup> {
      calls.push('lookup');
      return { kind: 'unknown', telemetry: 'rehearsal-blocked' };
    },
    async resume() { calls.push('resume'); throw new Error('unreachable'); },
    async restart() { calls.push('restart'); throw new Error('unreachable'); },
    async terminate() { calls.push('terminate'); throw new Error('unreachable'); },
  };
  return {
    render: {
      ...common,
      async create() { calls.push('create'); throw new Error('unreachable'); },
    },
    backfill: {
      ...common,
      async createBatch() { calls.push('createBatch'); throw new Error('unreachable'); },
    },
  };
}

function completedPurgeAccessors(): CoverPurgeWorkflowAccessors {
  const common = {
    async lookup(): Promise<CoverWorkflowLookup> {
      return { kind: 'status', status: 'complete' };
    },
    async resume() { throw new Error('unreachable'); },
    async restart() { throw new Error('unreachable'); },
    async terminate() { throw new Error('unreachable'); },
  };
  return {
    render: { ...common, async create() { throw new Error('unreachable'); } },
    backfill: { ...common, async createBatch() { throw new Error('unreachable'); } },
  };
}

describe('the populated interrupted cover-backfill rehearsal', () => {
  beforeEach(resetDatabase);

  it('re-enters every durable edge and closes only from a fresh Worker proof', async () => {
    const entries = await seedPopulatedInventory();
    const firstPage = await inventoryPage(null);
    const secondPage = await inventoryPage(firstPage.at(-1)!);
    const exhausted = await inventoryPage(secondPage.at(-1)!);
    expect([firstPage.length, secondPage.length, exhausted.length]).toEqual([100, 1, 0]);
    expect(entries).toHaveLength(101);

    expect(await runCounters()).toEqual({
      total_count: 101, queued_count: 101, applied_count: 0, skipped_count: 0,
      resolved_count: 0, failed_count: 0, needs_replacement_count: 0,
    });
    expect(await proveZeroLegacyCovers(testEnv)).toEqual({
      legacyRows: 101, blockingJobs: 0, incompleteActiveSets: 0,
      uploadsWithoutActiveSet: 0, proven: false,
    });

    const dispatchBatchSizes: number[] = [];
    await claimBatch(entries.slice(0, 25));
    dispatchBatchSizes.push(25);
    const claimed = await testEnv.DB.prepare(`
      SELECT id, workflow_instance_id, dispatch_generation, dispatch_state
      FROM event_cover_backfill_jobs WHERE run_id = ? AND id <= ? ORDER BY id
    `).bind(RUN_ID, entries[24]!.jobId).all<{
      id: string; workflow_instance_id: string; dispatch_generation: number; dispatch_state: string;
    }>();
    expect(claimed.results).toEqual(entries.slice(0, 25).map((entry) => ({
      id: entry.jobId, workflow_instance_id: entry.instanceId,
      dispatch_generation: 1, dispatch_state: 'creating',
    })));

    // 001: a genuine same-source replacement blocker, then a host removal and
    // the global resolver. The proof is red only while that exact source lives.
    await confirm(entries[1]!);
    expect((await coverBackfillPreflight(testEnv, entries[1]!.payload, START)).shouldContinue)
      .toBe(true);
    const tooSmall = withRecordingImages({ source: { width: 300, height: 200 } }).env;
    expect((await coverBackfillNormalize(tooSmall, entries[1]!.payload, START)).outcome.status)
      .toBe('needs_replacement');
    expect(await runCounters()).toEqual({
      total_count: 101, queued_count: 100, applied_count: 0, skipped_count: 0,
      resolved_count: 0, failed_count: 0, needs_replacement_count: 1,
    });
    expect(await proveZeroLegacyCovers(testEnv)).toMatchObject({
      legacyRows: 101, blockingJobs: 1, proven: false,
    });
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = NULL WHERE id = ?')
      .bind(entries[1]!.eventId).run();
    expect(await resolveSupersededBackfillJobsBounded(testEnv, START)).toEqual({
      inspectedJobs: 1, resolvedJobs: 1, closedVerifiedRuns: 0, closedFailedRuns: 0,
      expiredRunsStamped: 0, remainder: false,
    });
    expect(await runCounters()).toEqual({
      total_count: 101, queued_count: 100, applied_count: 0, skipped_count: 0,
      resolved_count: 1, failed_count: 0, needs_replacement_count: 0,
    });
    expect(await proveZeroLegacyCovers(testEnv)).toMatchObject({
      legacyRows: 100, blockingJobs: 0, proven: false,
    });

    // 003: deletion owns the fence before confirmation. The claimed unit is
    // blocked without consulting or triggering the platform.
    const deletionBeforeConfirmPlatformCalls: string[] = [];
    expect(await reconcileEventCoverPurge(
      testEnv, entries[3]!.eventId, START,
      blockingPurgeAccessors(deletionBeforeConfirmPlatformCalls),
    )).toMatchObject({ phase: 'fences', remainder: true });
    expect(await confirmCoverBackfillDispatch(testEnv, {
      ...entries[3]!.payload, generation: 1, now: START,
    })).toBe('blocked');
    expect(await row(
      'SELECT dispatch_state, status, failure_code FROM event_cover_backfill_jobs WHERE id = ?',
      entries[3]!.jobId,
    )).toEqual({ dispatch_state: 'creating', status: 'failed', failure_code: 'EVENT_DELETED' });
    expect(deletionBeforeConfirmPlatformCalls).toEqual([]);

    // 004: preflight succeeds, then purge fencing lands before normalization.
    // The delegated bucket records actual put attempts, not inferred objects.
    const rendered = withRecordingR2Puts(withRecordingImages({
      encode: (call) => ({
        bytes: new Uint8Array(1_000).fill(7), width: 0, height: 0,
        contentType: (call.output as { format?: string }).format ?? 'image/webp',
      }),
    }).env);
    await confirm(entries[4]!);
    expect((await coverBackfillPreflight(rendered.env, entries[4]!.payload, START)).shouldContinue)
      .toBe(true);
    const putsAtFence = rendered.puts.length;
    const prefixAtFence = (await rendered.env.MEDIA_BUCKET.list({
      prefix: `events/${entries[4]!.eventId}/cover/`,
    })).objects.map((object) => object.key).sort();
    expect(await reconcileEventCoverPurge(
      testEnv, entries[4]!.eventId, START, blockingPurgeAccessors(),
    )).toMatchObject({ phase: 'fences', remainder: true });
    expect((await coverBackfillNormalize(rendered.env, entries[4]!.payload, START)).outcome.status)
      .toBe('skipped');
    expect(await row(
      'SELECT status, failure_code FROM event_cover_backfill_jobs WHERE id = ?', entries[4]!.jobId,
    )).toEqual({ status: 'failed', failure_code: 'EVENT_DELETED' });
    expect(rendered.puts).toHaveLength(putsAtFence);
    expect((await rendered.env.MEDIA_BUCKET.list({
      prefix: `events/${entries[4]!.eventId}/cover/`,
    })).objects.map((object) => object.key).sort()).toEqual(prefixAtFence);

    // 006/007: both accepted creates were interrupted. One was absent; one had
    // materialized while its output was lost. Replaying the stored IDs creates
    // only the absent one and confirms both without a lookup.
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_backfill_jobs SET updated_at = ? WHERE id IN (?, ?)
      `).bind(STALE.toISOString(), entries[6]!.jobId, entries[7]!.jobId),
      // Exact open fences own the claim clock. Backdate both durable copies to
      // rehearse an honestly stale claim rather than artifact-clock skew.
      testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences SET updated_at = ?
        WHERE workflow_binding = 'COVER_BACKFILL_WORKFLOW'
          AND workflow_instance_id IN (?, ?)
      `).bind(STALE.toISOString(), entries[6]!.instanceId, entries[7]!.instanceId),
    ]);
    const materialized = new Set([entries[7]!.instanceId]);
    const createCalls: string[] = [];
    const physicalCreates: string[] = [];
    const initialRecovery: CoverBackfillWorkflowAccessor = {
      async lookup() { throw new Error('stale initial recovery must not look up'); },
      async createBatch(batch) {
        for (const candidate of batch) {
          createCalls.push(candidate.id);
          if (!materialized.has(candidate.id)) physicalCreates.push(candidate.id);
          materialized.add(candidate.id);
        }
      },
      async resume() { throw new Error('unreachable'); },
      async restart() { throw new Error('unreachable'); },
      async terminate() { throw new Error('unreachable'); },
    };
    expect(await recoverStaleInitialBackfillDispatches(testEnv, START, initialRecovery)).toEqual({
      inspected: 2, materialized: 2, confirmed: 2, blocked: 0, remainder: false,
    });
    expect(createCalls).toEqual([entries[6]!.instanceId, entries[7]!.instanceId]);
    expect(physicalCreates).toEqual([entries[6]!.instanceId]);
    for (const entry of [entries[6]!, entries[7]!]) {
      await testEnv.DB.prepare('UPDATE events SET cover_object_key = NULL WHERE id = ?')
        .bind(entry.eventId).run();
      expect((await coverBackfillPreflight(testEnv, entry.payload, START)).outcome.status)
        .toBe('skipped');
      expect((await jobPins(entry.jobId)).dispatch_generation).toBe(1);
    }

    // 008: an arbitrary binding failure is only unknown. Every selected D1 byte
    // stays unchanged until independent host action makes the job skippable.
    await confirm(entries[8]!);
    const unknownJobBefore = JSON.stringify(await row(
      'SELECT * FROM event_cover_backfill_jobs WHERE id = ?', entries[8]!.jobId,
    ));
    const unknownFenceBefore = JSON.stringify(await row(
      'SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
      entries[8]!.instanceId,
    ));
    const unknownRunBefore = JSON.stringify(await row(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN_ID,
    ));
    const unknownCalls: string[] = [];
    const unknownPlatform: CoverBackfillWorkflowAccessor = {
      async lookup(id) { unknownCalls.push(id); throw new Error('arbitrary binding error'); },
      async createBatch() { throw new Error('unreachable'); },
      async resume() { throw new Error('unreachable'); },
      async restart() { throw new Error('unreachable'); },
      async terminate() { throw new Error('unreachable'); },
    };
    expect(await reconcileCoverBackfillJobs(testEnv, START, unknownPlatform)).toEqual({
      inspected: 1, resumed: 0, restarted: 0, recreated: 0, failuresRecorded: 0,
      blocked: 0, unchanged: 1, remainder: false,
    });
    expect(unknownCalls).toEqual([entries[8]!.instanceId]);
    expect(JSON.stringify(await row(
      'SELECT * FROM event_cover_backfill_jobs WHERE id = ?', entries[8]!.jobId,
    ))).toBe(unknownJobBefore);
    expect(JSON.stringify(await row(
      'SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
      entries[8]!.instanceId,
    ))).toBe(unknownFenceBefore);
    expect(JSON.stringify(await row(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN_ID,
    ))).toBe(unknownRunBefore);
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = NULL WHERE id = ?')
      .bind(entries[8]!.eventId).run();
    expect((await coverBackfillPreflight(testEnv, entries[8]!.payload, START)).outcome.status)
      .toBe('skipped');

    // 000: the uninterrupted control path.
    await confirm(entries[0]!);
    expect((await coverBackfillPreflight(rendered.env, entries[0]!.payload, START)).shouldContinue)
      .toBe(true);
    expect((await coverBackfillNormalize(rendered.env, entries[0]!.payload, START)).shouldContinue)
      .toBe(true);
    await renderAll(rendered.env, entries[0]!);
    expect(await coverBackfillFinalize(rendered.env, entries[0]!.payload, START))
      .toMatchObject({ status: 'applied', appliedRevision: 1 });

    // 002: a complete staging result loses the final compare-and-swap to a host
    // cover. The host's independently complete set remains the active pointer.
    await confirm(entries[2]!);
    await coverBackfillPreflight(rendered.env, entries[2]!.payload, START);
    await coverBackfillNormalize(rendered.env, entries[2]!.payload, START);
    await seedManifestObjects(entries[2]!);
    const hostReplacement = await seedCompleteActiveCover(entries[2]!.eventId, 'host-replacement');
    expect((await coverBackfillFinalize(rendered.env, entries[2]!.payload, START)).status)
      .toBe('skipped');
    expect(await row(
      'SELECT cover_object_key, cover_render_set_id, cover_revision FROM events WHERE id = ?',
      entries[2]!.eventId,
    )).toEqual({
      cover_object_key: hostReplacement.masterKey,
      cover_render_set_id: hostReplacement.setId,
      cover_revision: 1,
    });

    // 005/009: one errored render restarts and one valid finalizing pause
    // resumes. Both retain the exact job, instance, master, set and manifest.
    await confirm(entries[5]!);
    await coverBackfillPreflight(rendered.env, entries[5]!.payload, START);
    await coverBackfillNormalize(rendered.env, entries[5]!.payload, START);
    await confirm(entries[9]!);
    await coverBackfillPreflight(rendered.env, entries[9]!.payload, START);
    await coverBackfillNormalize(rendered.env, entries[9]!.payload, START);
    await renderAll(rendered.env, entries[9]!);
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs SET status = 'finalizing' WHERE id = ?
    `).bind(entries[9]!.jobId).run();
    const restartPins = await jobPins(entries[5]!.jobId);
    const resumePins = await jobPins(entries[9]!.jobId);
    const graphCountsBefore = await row<{ masters: number; sets: number }>(`
      SELECT (SELECT count(*) FROM event_cover_masters WHERE event_id IN (?, ?)) AS masters,
        (SELECT count(*) FROM event_cover_render_sets WHERE event_id IN (?, ?)) AS sets
    `, entries[5]!.eventId, entries[9]!.eventId, entries[5]!.eventId, entries[9]!.eventId);
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences SET updated_at = ?
      WHERE workflow_instance_id IN (?, ?)
    `).bind(STALE.toISOString(), entries[5]!.instanceId, entries[9]!.instanceId).run();
    const recoveryCalls: string[] = [];
    const recoveryStatus = new Map<string, CoverWorkflowLookup>([
      [entries[5]!.instanceId, { kind: 'status', status: 'errored' }],
      [entries[9]!.instanceId, { kind: 'status', status: 'paused' }],
    ]);
    const recoveryPlatform: CoverBackfillWorkflowAccessor = {
      async lookup(id) {
        recoveryCalls.push(`lookup:${id}`);
        return recoveryStatus.get(id) ?? { kind: 'unknown', telemetry: 'missing-script' };
      },
      async createBatch() { throw new Error('unreachable'); },
      async resume(id) {
        recoveryCalls.push(`resume:${id}`);
        recoveryStatus.set(id, { kind: 'status', status: 'running' });
      },
      async restart(id) {
        recoveryCalls.push(`restart:${id}`);
        recoveryStatus.set(id, { kind: 'status', status: 'running' });
      },
      async terminate() { throw new Error('unreachable'); },
    };
    expect(await reconcileCoverBackfillJobs(testEnv, START, recoveryPlatform)).toEqual({
      inspected: 2, resumed: 1, restarted: 1, recreated: 0, failuresRecorded: 1,
      blocked: 0, unchanged: 0, remainder: false,
    });
    expect(recoveryCalls).toEqual([
      `lookup:${entries[5]!.instanceId}`, `restart:${entries[5]!.instanceId}`,
      `lookup:${entries[9]!.instanceId}`, `resume:${entries[9]!.instanceId}`,
    ]);
    for (const [before, entry] of [
      [restartPins, entries[5]!], [resumePins, entries[9]!],
    ] as const) {
      const after = await jobPins(entry.jobId);
      expect({ ...after, dispatch_generation: before.dispatch_generation })
        .toEqual(before);
      expect(after.dispatch_generation).toBe(2);
      expect(await row(`
        SELECT j.dispatch_state, j.dispatch_generation,
          f.state AS fence_state, f.dispatch_generation AS fence_generation
        FROM event_cover_backfill_jobs j
        JOIN event_cover_workflow_fences f
          ON f.workflow_binding = 'COVER_BACKFILL_WORKFLOW'
         AND f.workflow_instance_id = j.workflow_instance_id AND f.event_id = j.event_id
        WHERE j.id = ?
      `, entry.jobId)).toEqual({
        dispatch_state: 'confirmed', dispatch_generation: 2,
        fence_state: 'open', fence_generation: 2,
      });
    }
    expect(await row(`
      SELECT (SELECT count(*) FROM event_cover_masters WHERE event_id IN (?, ?)) AS masters,
        (SELECT count(*) FROM event_cover_render_sets WHERE event_id IN (?, ?)) AS sets
    `, entries[5]!.eventId, entries[9]!.eventId, entries[5]!.eventId, entries[9]!.eventId))
      .toEqual(graphCountsBefore);
    await renderAll(rendered.env, entries[5]!);
    expect((await coverBackfillFinalize(rendered.env, entries[5]!.payload, START)).status)
      .toBe('applied');
    expect((await coverBackfillFinalize(rendered.env, entries[9]!.payload, START)).status)
      .toBe('applied');

    // Finish the remaining fifteen jobs in the first batch by host removal.
    for (const entry of entries.slice(10, 25)) await confirm(entry);
    await batchD1Statements(testEnv.DB, entries.slice(10, 25).map((entry) => (
      testEnv.DB.prepare('UPDATE events SET cover_object_key = NULL WHERE id = ?').bind(entry.eventId)
    )));
    for (const entry of entries.slice(10, 25)) {
      expect((await coverBackfillPreflight(testEnv, entry.payload, START)).outcome.status)
        .toBe('skipped');
    }
    expect(await runCounters()).toEqual({
      total_count: 101, queued_count: 76, applied_count: 3, skipped_count: 19,
      resolved_count: 1, failed_count: 2, needs_replacement_count: 0,
    });
    expect(await proveZeroLegacyCovers(testEnv)).toEqual({
      legacyRows: 76, blockingJobs: 0, incompleteActiveSets: 0,
      uploadsWithoutActiveSet: 0, proven: false,
    });

    // Drain three more full 25-row dispatches and the final one-row dispatch.
    // Backdating completed fence clocks simulates the operator's next minute
    // without sleeps or a second clock source.
    for (let start = 25; start < entries.length; start += 25) {
      await testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences SET updated_at = ?
        WHERE workflow_binding = 'COVER_BACKFILL_WORKFLOW'
      `).bind(STALE.toISOString()).run();
      const batch = entries.slice(start, Math.min(start + 25, entries.length));
      await claimBatch(batch);
      dispatchBatchSizes.push(batch.length);
      for (const entry of batch) await confirm(entry);
      await batchD1Statements(testEnv.DB, batch.map((entry) => (
        testEnv.DB.prepare('UPDATE events SET cover_object_key = NULL WHERE id = ?')
          .bind(entry.eventId)
      )));
      for (const entry of batch) {
        expect((await coverBackfillPreflight(testEnv, entry.payload, START)).outcome.status)
          .toBe('skipped');
      }
    }
    const noPending = await testEnv.DB.prepare(`
      SELECT id FROM event_cover_backfill_jobs
      WHERE run_id = ? AND status = 'queued' AND dispatch_state = 'pending'
      ORDER BY id LIMIT 25
    `).bind(RUN_ID).all<{ id: string }>();
    dispatchBatchSizes.push(noPending.results.length);
    expect(dispatchBatchSizes).toEqual([25, 25, 25, 25, 1, 0]);

    expect(await runCounters()).toEqual({
      total_count: 101, queued_count: 0, applied_count: 3, skipped_count: 95,
      resolved_count: 1, failed_count: 2, needs_replacement_count: 0,
    });
    expect(await proveZeroLegacyCovers(testEnv)).toEqual({
      legacyRows: 0, blockingJobs: 0, incompleteActiveSets: 0,
      uploadsWithoutActiveSet: 0, proven: true,
    });
    expect(await row(
      'SELECT status, verified_at FROM event_cover_backfill_runs WHERE id = ?', RUN_ID,
    )).toEqual({ status: 'executing', verified_at: null });

    // A green display is not closure. Only the Worker's guarded transition can
    // verify this run, and its replay is intentionally inert.
    expect(await closeCoverBackfillRuns(testEnv, START)).toEqual({
      inspectedJobs: 0, resolvedJobs: 0, closedVerifiedRuns: 1, closedFailedRuns: 0,
      expiredRunsStamped: 1, remainder: false,
    });
    const closedRun = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN_ID,
    );
    expect(closedRun).toMatchObject({ status: 'verified', verified_at: START.toISOString() });

    // Terminal purge re-entry removes the two deleted events and their jobs,
    // then recomputes the already-verified retained run from its remaining rows.
    // The rehearsal advances a fixed logical clock while D1 stamps claims from
    // the wall clock, so align the preserved job claim clocks with that simulated
    // apply instant before proving that the five-minute re-entry is stale.
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs SET updated_at = ? WHERE id IN (?, ?)
    `).bind(START.toISOString(), entries[3]!.jobId, entries[4]!.jobId).run();
    for (const entry of [entries[3]!, entries[4]!]) {
      expect(await reconcileEventCoverPurge(
        testEnv, entry.eventId, PURGE_REENTRY, completedPurgeAccessors(),
      )).toMatchObject({ phase: 'complete', remainder: false });
    }
    expect(await runCounters()).toEqual({
      total_count: 99, queued_count: 0, applied_count: 3, skipped_count: 95,
      resolved_count: 1, failed_count: 0, needs_replacement_count: 0,
    });
    expect(await closeCoverBackfillRuns(testEnv, PURGE_REENTRY)).toEqual({
      inspectedJobs: 0, resolvedJobs: 0, closedVerifiedRuns: 0, closedFailedRuns: 0,
      expiredRunsStamped: 0, remainder: false,
    });
    const retainedRun = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN_ID,
    );
    expect(retainedRun).toMatchObject({
      status: closedRun.status,
      verified_at: closedRun.verified_at,
      expires_at: closedRun.expires_at,
    });

    // A saved inventory unit cannot append to or refresh a closed execute run.
    const jobsBeforeReplay = await row<{ count: number }>(
      'SELECT count(*) AS count FROM event_cover_backfill_jobs WHERE run_id = ?', RUN_ID,
    );
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_jobs (
          id, run_id, event_id, expected_revision, legacy_key_fingerprint,
          workflow_instance_id, dispatch_state, dispatch_generation, status,
          dependency_versions_json, created_at, updated_at
        ) SELECT 'inventory-replay-job', ?, ?, 1, ?, 'inventory-replay-instance',
          'pending', 0, 'queued', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM event_cover_backfill_runs
          WHERE id = ? AND mode = 'inventory' AND status = 'inventorying')
      `).bind(
        RUN_ID, '30000000-0000-4000-8000-000000000000', HEX,
        JSON.stringify(coverBackfillDependencyVersions()), START.toISOString(),
        START.toISOString(), RUN_ID,
      ),
      testEnv.DB.prepare(`
        UPDATE event_cover_backfill_runs SET total_count = 0, queued_count = 0, updated_at = ?
        WHERE id = ? AND mode = 'inventory' AND status = 'inventorying'
      `).bind(PURGE_REENTRY.toISOString(), RUN_ID),
    ]);
    expect(await row(
      'SELECT count(*) AS count FROM event_cover_backfill_jobs WHERE run_id = ?', RUN_ID,
    )).toEqual(jobsBeforeReplay);
    expect(await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN_ID,
    )).toEqual(retainedRun);
    expect(await proveZeroLegacyCovers(testEnv)).toMatchObject({ proven: true });
  }, 20_000);
});

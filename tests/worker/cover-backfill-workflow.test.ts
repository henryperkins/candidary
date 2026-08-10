import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
  MAX_COVER_BACKFILL_IN_FLIGHT,
} from '../../shared/constants';
import {
  ROLLING_CLAIM_WINDOW_SQL,
  claimCoverBackfillDispatchSql,
} from '../../shared/cover-dispatch';
import { COVER_PIPELINE_VERSIONS, EVENT_COVER_PROFILES } from '../../shared/event-cover';
import { EventsRepository } from '../../worker/db/events';
import {
  BACKFILL_RESTART_WINDOW_MS,
  confirmCoverBackfillDispatch,
  coverBackfillConfirmStep,
  coverBackfillDependencyVersions,
  coverBackfillFinalize,
  coverBackfillInstanceId,
  coverBackfillNormalize,
  coverBackfillPreflight,
  coverBackfillProfileStep,
  closeCoverBackfillRuns,
  proveZeroLegacyCovers,
  recordZeroLegacyVerification,
  reconcileCoverBackfillJobs,
  recoverStaleInitialBackfillDispatches,
  resolveSupersededBackfillJobsBounded,
} from '../../worker/workflows/cover-backfill';
import type {
  CoverBackfillWorkflowAccessor,
  CoverWorkflowLookup,
} from '../../worker/workflows/cover-platform';
import { coverKeyFingerprint, coverMasterKey } from '../../worker/storage/event-cover-keys';
import {
  reconcileEventCoverPurge,
  type CoverPurgeWorkflowAccessors,
} from '../../worker/workflows/cleanup';
import {
  eventAccess,
  resetDatabaseToPhase2CoverSchema as resetDatabase,
  seedEventCoverGraph,
  testEnv,
  withRecordingImages,
} from './helpers';
import type { AppEnv } from '../../worker/env';

const now = new Date('2026-08-05T12:00:00.000Z');
const RUN = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const FENCE_HOLD = '9999-12-31T23:59:59.999Z';
const PINNED_MASTER = '33333333-3333-4333-8333-333333333333';
const PINNED_RENDER_SET = '44444444-4444-4444-8444-444444444444';
const SENSITIVE_PLATFORM_DETAIL = 'events/private/cover/cr1-secret';

const PINNED_MANIFEST_SLOTS = [
  { profile: 'short-lookup', density: '1x', format: 'webp' },
  { profile: 'short-lookup', density: '1x', format: 'jpeg' },
  { profile: 'compact-default', density: '1x', format: 'webp' },
  { profile: 'compact-default', density: '1x', format: 'jpeg' },
  { profile: 'standard-default', density: '1x', format: 'webp' },
  { profile: 'standard-default', density: '1x', format: 'jpeg' },
  { profile: 'framed-default', density: '1x', format: 'webp' },
  { profile: 'framed-default', density: '1x', format: 'jpeg' },
  { profile: 'compact-expanded', density: '1x', format: 'webp' },
  { profile: 'compact-expanded', density: '1x', format: 'jpeg' },
  { profile: 'wide-expanded', density: '1x', format: 'webp' },
  { profile: 'wide-expanded', density: '1x', format: 'jpeg' },
] as const;
const PINNED_MANIFEST_JSON = JSON.stringify({ slots: PINNED_MANIFEST_SLOTS });

type Access = Awaited<ReturnType<typeof eventAccess>>;

/**
 * A platform that can tell the coordinator nothing.
 *
 * Parks the purge in its fence phase without a single mutation, which is the
 * state a late dispatcher has to be refused in.
 */
function blockingAccessors(): CoverPurgeWorkflowAccessors {
  const shared = {
    async lookup() { return { kind: 'unknown' as const, telemetry: 'test' }; },
    async resume() { throw new Error('unreachable'); },
    async restart() { throw new Error('unreachable'); },
    async terminate() { throw new Error('unreachable'); },
  };
  return {
    render: { ...shared, async create() { throw new Error('unreachable'); } },
    backfill: { ...shared, async createBatch() { throw new Error('unreachable'); } },
  };
}

/** Fixed and small, so every slot lands inside its own byte ceiling. */
function backfillEnv(source?: { width: number; height: number }): AppEnv {
  return withRecordingImages({
    source,
    encode: () => ({
      bytes: new Uint8Array(20_000).fill(3), width: 0, height: 0, contentType: 'image/webp',
    }),
  }).env;
}

function legacyKey(eventId: string): string {
  return `events/${eventId}/cover/7a2f-porch.jpg`;
}

async function row<T>(sql: string, ...binds: unknown[]): Promise<T> {
  return (await testEnv.DB.prepare(sql).bind(...binds).first<T>())!;
}

interface SeedOptions {
  runId?: string;
  jobId?: string;
  revision?: number;
  /** Defaults to a job already past its dispatch, which is what most steps need. */
  dispatchState?: string;
  dispatchGeneration?: number;
  /** Defaults to matching the job, which is what an uninterrupted claim leaves. */
  fenceGeneration?: number;
  fenceState?: string;
  /** How long ago the claim was made, for the staleness threshold. */
  claimedAt?: Date;
  status?: string;
  /** A recorded platform failure, for the restart-window predicate. */
  terminalAt?: Date;
  retryable?: 0 | 1;
  failureCode?: string;
  dependencyVersions?: Record<string, number>;
}

/** One legacy row, one run, and one job created against exactly that row. */
async function seedJob(access: Access, options: SeedOptions = {}) {
  const runId = options.runId ?? RUN;
  const jobId = options.jobId ?? JOB;
  const key = legacyKey(access.event.id);
  const revision = options.revision ?? 0;
  const dispatchState = options.dispatchState ?? 'confirmed';
  const generation = options.dispatchGeneration ?? 0;
  const fenceGeneration = options.fenceGeneration ?? generation;
  const fenceState = options.fenceState ?? 'open';
  const claimedAt = (options.claimedAt ?? now).toISOString();
  const status = options.status ?? 'queued';
  await testEnv.MEDIA_BUCKET.put(key, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
  await testEnv.DB.prepare(
    'UPDATE events SET cover_object_key = ?, cover_revision = ? WHERE id = ?',
  ).bind(key, revision, access.event.id).run();

  await testEnv.DB.prepare(`
    INSERT OR IGNORE INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
    VALUES (?, 'execute', 'executing', ?, ?)
  `).bind(runId, now.toISOString(), now.toISOString()).run();

  const instanceId = await coverBackfillInstanceId(runId, jobId, access.event.id);
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_backfill_jobs (
      id, run_id, event_id, expected_revision, legacy_key_fingerprint, workflow_instance_id,
      dispatch_state, dispatch_generation, status, dependency_versions_json,
      failure_code, retryable, terminal_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    jobId, runId, access.event.id, revision, await coverKeyFingerprint(key), instanceId,
    dispatchState, generation, status,
    JSON.stringify(options.dependencyVersions ?? coverBackfillDependencyVersions()),
    options.failureCode ?? null, options.retryable ?? 0,
    options.terminalAt?.toISOString() ?? null,
    now.toISOString(), claimedAt,
  ).run();

  await testEnv.DB.prepare(`
    INSERT INTO event_cover_workflow_fences (
      workflow_binding, workflow_instance_id, event_id, dispatch_generation, state,
      created_at, updated_at, expires_at
    ) VALUES ('COVER_BACKFILL_WORKFLOW', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    instanceId, access.event.id, fenceGeneration, fenceState,
    now.toISOString(), claimedAt,
    FENCE_HOLD,
  ).run();

  return { key, instanceId, payload: { runId, jobId, eventId: access.event.id } };
}

/** Complete but reconciliation-ineligible initial claims that occupy run capacity. */
async function seedOtherLiveBackfillJobs(count: number): Promise<void> {
  const claimedAt = '2020-01-01T00:00:00.000Z';
  const statements = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index + 1).padStart(12, '0');
    const eventId = `90000000-0000-4000-8000-${suffix}`;
    const jobId = `80000000-0000-4000-8000-${suffix}`;
    const instanceId = `cb1-${String(index + 1).padStart(48, '0')}`;
    statements.push(
      testEnv.DB.prepare(`
        INSERT INTO events (
          id, slug, name, event_date, welcome_message, cover_object_key,
          guest_access_expires_at, management_access_expires_at, purge_after, created_at
        ) VALUES (?, ?, 'Capacity', '2026-08-08', 'Welcome', ?, ?, ?, ?, ?)
      `).bind(
        eventId, `capacity-${index}`, legacyKey(eventId),
        now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString(),
      ),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_jobs (
          id, run_id, event_id, expected_revision, legacy_key_fingerprint,
          workflow_instance_id, dispatch_state, dispatch_generation, status,
          dependency_versions_json, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, ?, 'creating', 1, 'queued', ?, ?, ?)
      `).bind(
        jobId, RUN, eventId, 'c'.repeat(64), instanceId,
        JSON.stringify(coverBackfillDependencyVersions()), claimedAt, claimedAt,
      ),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        ) VALUES ('COVER_BACKFILL_WORKFLOW', ?, ?, 1, 'open', ?, ?, ?)
      `).bind(instanceId, eventId, claimedAt, claimedAt, FENCE_HOLD),
    );
  }
  if (statements.length > 0) await testEnv.DB.batch(statements);
}

interface LedgerSeed {
  runId: string;
  jobId: string;
  eventId: string;
  fingerprint: string;
  updatedAt: string;
  status?: 'needs_replacement' | 'failed';
  expectedRevision?: number;
  retryable?: 0 | 1;
  failureCode?: string;
  terminalAt?: string | null;
  referenceReleaseAt?: string | null;
  expiresAt?: string | null;
  workflowInstanceId?: string;
  dispatchState?: string;
  dispatchGeneration?: number;
  fence?: boolean;
}

/** Minimal truthful ledger rows for global sweep tests, without a Workflow call. */
async function seedLedgerRows(seeds: readonly LedgerSeed[]) {
  const statements = seeds.flatMap((seed) => {
    const status = seed.status ?? 'needs_replacement';
    return [
      testEnv.DB.prepare(`
        INSERT OR IGNORE INTO event_cover_backfill_runs (
          id, mode, total_count, failed_count, needs_replacement_count,
          status, created_at, updated_at
        ) VALUES (?, 'execute', 1, ?, ?, 'executing', ?, ?)
      `).bind(
        seed.runId, status === 'failed' ? 1 : 0, status === 'needs_replacement' ? 1 : 0,
        seed.updatedAt, seed.updatedAt,
      ),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_jobs (
          id, run_id, event_id, expected_revision, legacy_key_fingerprint,
          workflow_instance_id, dispatch_state, dispatch_generation, status,
          dependency_versions_json, failure_code, retryable, terminal_at,
          reference_release_at, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        seed.jobId, seed.runId, seed.eventId, seed.expectedRevision ?? 0, seed.fingerprint,
        seed.workflowInstanceId ?? `instance-${seed.jobId}`,
        seed.dispatchState ?? 'confirmed', seed.dispatchGeneration ?? 1, status,
        JSON.stringify(coverBackfillDependencyVersions()), seed.failureCode ?? null,
        seed.retryable ?? 0, seed.terminalAt ?? null,
        seed.referenceReleaseAt ?? null, seed.expiresAt ?? null,
        seed.updatedAt, seed.updatedAt,
      ),
      ...(seed.fence ? [testEnv.DB.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        ) VALUES ('COVER_BACKFILL_WORKFLOW', ?, ?, ?, 'open', ?, ?, ?)
      `).bind(
        seed.workflowInstanceId ?? `instance-${seed.jobId}`, seed.eventId,
        seed.dispatchGeneration ?? 1, seed.updatedAt, seed.updatedAt, FENCE_HOLD,
      )] : []),
    ];
  });
  for (let offset = 0; offset < statements.length; offset += 100) {
    await testEnv.DB.batch(statements.slice(offset, offset + 100));
  }
}

async function testSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function seedPinnedFailedJob(
  access: Access,
  options: {
    manifestJson?: string;
    manifestSha256?: string;
    adopted?: readonly { profile: string; density: string; format: string }[];
  } = {},
) {
  const seeded = await seedJob(access, {
    dispatchState: 'confirmed', dispatchGeneration: 1, fenceGeneration: 1,
    status: 'failed', retryable: 1, failureCode: 'COVER_RENDER_UNAVAILABLE',
    terminalAt: new Date(now.getTime() - 60_000),
  });
  const manifestJson = options.manifestJson ?? PINNED_MANIFEST_JSON;
  const manifestSha256 = options.manifestSha256 ?? await testSha256(manifestJson);
  const masterKey = `events/${access.event.id}/cover/masters/${PINNED_MASTER}.webp`;

  await testEnv.DB.prepare(`
    INSERT INTO event_cover_masters (
      id, event_id, object_key, mime_type, byte_size, width, height, sha256,
      normalization_version, normalization_rung, auto_focus_x, auto_focus_y,
      composition_model_version, created_at
    ) VALUES (?, ?, ?, 'image/webp', 1000, 1200, 800, ?, 1, 1, 0.5, 0.5, 1, ?)
  `).bind(PINNED_MASTER, access.event.id, masterKey, 'c'.repeat(64), now.toISOString()).run();
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_render_sets (
      id, event_id, master_id, draft_id, recipe_json, recipe_sha256,
      state, required_slots, created_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'staging', 12, ?)
  `).bind(
    PINNED_RENDER_SET, access.event.id, PINNED_MASTER,
    '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
    'd'.repeat(64), now.toISOString(),
  ).run();
  await testEnv.DB.prepare(`
    UPDATE event_cover_backfill_jobs
    SET master_id = ?, render_set_id = ?, manifest_json = ?, manifest_sha256 = ?
    WHERE id = ?
  `).bind(PINNED_MASTER, PINNED_RENDER_SET, manifestJson, manifestSha256, JOB).run();

  for (const [index, slot] of (options.adopted ?? []).entries()) {
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_render_objects (
        id, render_set_id, event_id, profile_id, density, format, object_key,
        content_type, byte_size, width, height, quality_rung, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, 360, 168, 1, ?, ?)
    `).bind(
      `pinned-object-${index}`, PINNED_RENDER_SET, access.event.id,
      slot.profile, slot.density, slot.format,
      `events/${access.event.id}/cover/rendered/${PINNED_RENDER_SET}/${slot.profile}-${slot.density}.${slot.format}`,
      slot.format === 'webp' ? 'image/webp' : 'image/jpeg', 'e'.repeat(64), now.toISOString(),
    ).run();
  }
  return seeded;
}

function envAfterAdoptedTupleRead(action: () => Promise<void>): AppEnv {
  let acted = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') {
        return (...values: unknown[]) => wrap(target.bind(...values));
      }
      if (property === 'all') {
        return async <T>() => {
          const result = await target.all<T>();
          if (!acted) {
            acted = true;
            await action();
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const db = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => sql.includes('FROM event_cover_render_objects')
          ? wrap(target.prepare(sql))
          : target.prepare(sql);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...testEnv, DB: db };
}

function envBeforeFirstBatch(action: () => Promise<void>): AppEnv {
  let acted = false;
  const db = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!acted) {
            acted = true;
            await action();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...testEnv, DB: db };
}

function envAfterFirstBatch(action: () => Promise<void>): AppEnv {
  let batches = 0;
  const db = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          batches += 1;
          if (batches === 1) await action();
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...testEnv, DB: db };
}

function zeroBackfillTailEnv(fragment: string): { env: AppEnv; wasInjected: () => boolean } {
  let injected = false;
  const db = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (!injected && sql.includes(fragment)) {
            injected = true;
            return target.prepare(`${sql}\nAND 0`);
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...testEnv, DB: db }, wasInjected: () => injected };
}

function backfillEnvRejectingManifestReads(): AppEnv {
  const bucket = new Proxy(testEnv.MEDIA_BUCKET, {
    get(target, property) {
      if (property === 'get') {
        return async () => { throw new Error('backfill ready checkpoint must be reused'); };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...testEnv, MEDIA_BUCKET: bucket };
}

/** Injects a classification-to-write race while every read still uses real D1. */
function envBeforeFirstLedgerWrite(action: () => Promise<void>): AppEnv {
  let acted = false;
  const beforeWrite = async () => {
    if (acted) return;
    acted = true;
    await action();
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(
    statement,
    {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        }
        if (property === 'run') {
          return async <T>() => {
            if (sql.includes('UPDATE event_cover_backfill_jobs')) await beforeWrite();
            return target.run<T>();
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    },
  );
  const db = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => wrap(target.prepare(sql), sql);
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          await beforeWrite();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...testEnv, DB: db };
}

function envWithLedgerReadTransform(
  transform: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): AppEnv {
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(
    statement,
    {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        }
        if (property === 'all') {
          return async <T>() => {
            const result = await target.all<T>();
            if (!sql.includes('AS event_exists')) return result;
            return { ...result, results: transform(result.results as Array<Record<string, unknown>>) };
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    },
  );
  const db = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...testEnv, DB: db };
}

async function renderEveryProfile(env: AppEnv, payload: { runId: string; jobId: string; eventId: string }) {
  for (const profile of EVENT_COVER_PROFILES) {
    await coverBackfillProfileStep(env, payload, profile.id, now);
  }
}

/**
 * A platform that records what it was asked to create and refuses to be asked
 * anything else. `lookup` throws on purpose: initial-create recovery replays an
 * accepted claim with its own stored ID, so it must never consult instance
 * status — inferring absence from a status read is the one thing the adapter
 * refuses to certify.
 */
function recordingBackfillAccessor(options: { failCreate?: boolean } = {}) {
  const created: string[] = [];
  const accessor: CoverBackfillWorkflowAccessor = {
    async lookup() { throw new Error('recovery must not look an instance up'); },
    async createBatch(input) {
      if (options.failCreate) throw new Error('platform unavailable');
      for (const entry of input) created.push(entry.id);
    },
    async resume() { throw new Error('unreachable'); },
    async restart() { throw new Error('unreachable'); },
    async terminate() { throw new Error('unreachable'); },
  };
  return { accessor, created };
}

/**
 * A platform whose answer for each instance is scripted, and which records every
 * call it receives in order.
 *
 * `resume` and `restart` rewrite their own instance's next reading the way the
 * real platform would, so a reconciliation that calls one and then re-reads sees
 * what actually happened rather than what it asked for.
 */
function scriptedBackfillAccessor(
  script: Record<string, CoverWorkflowLookup | 'throw'> = {},
  failures: { resume?: boolean; restart?: boolean; create?: boolean } = {},
) {
  const calls: string[] = [];
  const scripted = new Map<string, CoverWorkflowLookup | 'throw'>(Object.entries(script));
  const accessor: CoverBackfillWorkflowAccessor = {
    async lookup(id) {
      calls.push(`lookup:${id}`);
      const entry = scripted.get(id);
      if (entry === 'throw') throw new Error(SENSITIVE_PLATFORM_DETAIL);
      return entry ?? { kind: 'status', status: 'running' };
    },
    async createBatch(input) {
      for (const entry of input) {
        calls.push(`createBatch:${entry.id}`);
        if (failures.create) throw new Error('platform unavailable');
        scripted.set(entry.id, { kind: 'status', status: 'running' });
      }
    },
    async resume(id) {
      calls.push(`resume:${id}`);
      if (failures.resume) throw new Error('platform unavailable');
      scripted.set(id, { kind: 'status', status: 'running' });
    },
    async restart(id) {
      calls.push(`restart:${id}`);
      if (failures.restart) throw new Error('platform unavailable');
      scripted.set(id, { kind: 'status', status: 'running' });
    },
    async terminate(id) { calls.push(`terminate:${id}`); },
  };
  return { accessor, calls };
}

const STALE = new Date(now.getTime() - 5 * 60 * 1000);

describe('initial dispatch confirmation', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  const claimed = (extra: SeedOptions = {}) => seedJob(access, {
    dispatchState: 'creating', dispatchGeneration: 1, ...extra,
  });

  it('confirms the claimed generation without moving the dispatch clock', async () => {
    const { payload, instanceId } = await claimed();
    const before = await row<{ updated_at: string }>(
      'SELECT updated_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId,
    );

    expect(await confirmCoverBackfillDispatch(testEnv, { ...payload, generation: 1, now }))
      .toBe('confirmed');

    expect(await row('SELECT dispatch_state, dispatch_generation FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ dispatch_state: 'confirmed', dispatch_generation: 1 });
    // The fence's `updated_at` is the durable dispatch-claim clock the rolling
    // minute is measured from. Confirming must not hand the next batch a minute
    // of capacity it never earned.
    expect(await row('SELECT dispatch_generation, updated_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId))
      .toEqual({ dispatch_generation: 1, updated_at: before.updated_at });
  });

  it('is a guarded replay the second time', async () => {
    const { payload } = await claimed();
    expect(await confirmCoverBackfillDispatch(testEnv, { ...payload, generation: 1, now })).toBe('confirmed');
    expect(await confirmCoverBackfillDispatch(testEnv, { ...payload, generation: 1, now })).toBe('confirmed');
    expect(await row('SELECT dispatch_generation FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ dispatch_generation: 1 });
  });

  it('refuses a generation the job is not standing at', async () => {
    const { payload } = await claimed();
    expect(await confirmCoverBackfillDispatch(testEnv, { ...payload, generation: 2, now })).toBe('stale');
    expect(await row('SELECT dispatch_state FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ dispatch_state: 'creating' });
  });

  it('refuses a fence that was swept, and one at another generation', async () => {
    const { payload, instanceId } = await claimed({ fenceGeneration: 4 });
    expect(await confirmCoverBackfillDispatch(testEnv, { ...payload, generation: 1, now })).toBe('stale');

    await testEnv.DB.prepare('DELETE FROM event_cover_workflow_fences WHERE workflow_instance_id = ?')
      .bind(instanceId).run();
    expect(await confirmCoverBackfillDispatch(testEnv, { ...payload, generation: 1, now })).toBe('stale');
    expect(await row('SELECT dispatch_state FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ dispatch_state: 'creating' });
  });

  it('refuses a job that has not been claimed yet', async () => {
    const { payload } = await seedJob(access, { dispatchState: 'pending', dispatchGeneration: 0 });
    expect(await confirmCoverBackfillDispatch(testEnv, { ...payload, generation: 0, now })).toBe('stale');
    expect(await row('SELECT dispatch_state FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ dispatch_state: 'pending' });
  });

  /**
   * The Workflow's own entry point carries no generation — the payload is
   * immutable across restarts and the generation is not — so it confirms
   * whichever one the ledger has the job standing at.
   */
  it('confirms from the payload alone, at whatever generation the ledger holds', async () => {
    const { payload } = await claimed({ dispatchGeneration: 3, fenceGeneration: 3 });
    expect(await coverBackfillConfirmStep(testEnv, payload, now)).toBe('confirmed');
    expect(await row('SELECT dispatch_state, dispatch_generation FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ dispatch_state: 'confirmed', dispatch_generation: 3 });

    await testEnv.DB.prepare('DELETE FROM event_cover_backfill_jobs WHERE id = ?').bind(JOB).run();
    expect(await coverBackfillConfirmStep(testEnv, payload, now)).toBe('stale');
  });

  it('settles the unit as EVENT_DELETED when a purge owns the fence', async () => {
    const { payload } = await claimed();
    // Through the production coordinator, never a hand-written fence state.
    const purge = await reconcileEventCoverPurge(testEnv, access.event.id, now, blockingAccessors());
    expect(purge).toMatchObject({ phase: 'fences', remainder: true });
    expect(await confirmCoverBackfillDispatch(testEnv, { ...payload, generation: 1, now })).toBe('blocked');

    // The coordinator's own batch already made this job terminal, so the check
    // above cannot show the confirmation writing anything. Put the job back to a
    // live claim — the fence stays exactly as the coordinator left it — and the
    // settlement statement is the only thing that can move it.
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET dispatch_state = 'creating', status = 'queued', failure_code = NULL,
          retryable = 0, terminal_at = NULL WHERE id = ?
    `).bind(JOB).run();

    expect(await confirmCoverBackfillDispatch(testEnv, { ...payload, generation: 1, now })).toBe('blocked');
    expect(await row('SELECT dispatch_state, status, failure_code, retryable FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ dispatch_state: 'blocked', status: 'failed', failure_code: 'EVENT_DELETED', retryable: 0 });
  });
});

describe('stale initial dispatch recovery', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('replays the stored instance ID and confirms it', async () => {
    const { instanceId } = await seedJob(access, {
      dispatchState: 'creating', dispatchGeneration: 1, claimedAt: STALE,
    });
    const platform = recordingBackfillAccessor();

    expect(await recoverStaleInitialBackfillDispatches(testEnv, now, platform.accessor))
      .toEqual({ inspected: 1, materialized: 1, confirmed: 1, blocked: 0, remainder: false });
    // The immutable stored ID, never a freshly derived one: a second ID for the
    // same job is a second instance nothing fences.
    expect(platform.created).toEqual([instanceId]);
    expect(await row('SELECT dispatch_state, dispatch_generation FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ dispatch_state: 'confirmed', dispatch_generation: 1 });
  });

  it('leaves the claim recoverable when the platform refuses', async () => {
    await seedJob(access, { dispatchState: 'creating', dispatchGeneration: 1, claimedAt: STALE });
    const platform = recordingBackfillAccessor({ failCreate: true });

    expect(await recoverStaleInitialBackfillDispatches(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, materialized: 0, confirmed: 0 });
    expect(await row('SELECT dispatch_state FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ dispatch_state: 'creating' });
  });

  it('does not touch a claim that is still inside the stale window', async () => {
    await seedJob(access, { dispatchState: 'creating', dispatchGeneration: 1 });
    const platform = recordingBackfillAccessor();

    expect(await recoverStaleInitialBackfillDispatches(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 0, materialized: 0 });
    expect(platform.created).toEqual([]);
  });

  it('uses the exact open fence clock when a legacy job clock is 119 seconds older', async () => {
    await seedJob(access, {
      dispatchState: 'creating', dispatchGeneration: 1, claimedAt: now,
    });
    // Models a claim written by the old launcher from an artifact generated on
    // another clock. The exact open fence is the database-stamped authority.
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs SET updated_at = ? WHERE id = ?
    `).bind('2020-01-01T00:00:00.000Z', JOB).run();
    const platform = recordingBackfillAccessor();
    const recoveryAt = new Date(now.getTime() + 119_000);

    expect(await recoverStaleInitialBackfillDispatches(testEnv, recoveryAt, platform.accessor))
      .toMatchObject({ inspected: 0, materialized: 0 });
    expect(platform.created).toEqual([]);
  });

  it('uses the exact open fence clock when a legacy job clock is 121 seconds newer', async () => {
    const { instanceId } = await seedJob(access, {
      dispatchState: 'creating', dispatchGeneration: 1, claimedAt: now,
    });
    // The inverse drift must not postpone recovery: the same exact fence clock
    // becomes stale two minutes after the database applied the claim.
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs SET updated_at = ? WHERE id = ?
    `).bind('2040-01-01T00:00:00.000Z', JOB).run();
    const platform = recordingBackfillAccessor();
    const recoveryAt = new Date(now.getTime() + 121_000);

    expect(await recoverStaleInitialBackfillDispatches(testEnv, recoveryAt, platform.accessor))
      .toEqual({ inspected: 1, materialized: 1, confirmed: 1, blocked: 0, remainder: false });
    expect(platform.created).toEqual([instanceId]);
  });

  it('settles a purge-owned claim instead of creating an instance for it', async () => {
    await seedJob(access, { dispatchState: 'creating', dispatchGeneration: 1, claimedAt: STALE });
    await reconcileEventCoverPurge(testEnv, access.event.id, now, blockingAccessors());
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET dispatch_state = 'creating', status = 'queued', failure_code = NULL,
          retryable = 0, terminal_at = NULL, updated_at = ? WHERE id = ?
    `).bind(STALE.toISOString(), JOB).run();
    const platform = recordingBackfillAccessor();

    expect(await recoverStaleInitialBackfillDispatches(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, materialized: 0, blocked: 1 });
    expect(platform.created).toEqual([]);
    expect(await row('SELECT status, failure_code FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ status: 'failed', failure_code: 'EVENT_DELETED' });
  });

  it('ignores a claim whose job has already moved past dispatch', async () => {
    await seedJob(access, {
      dispatchState: 'creating', dispatchGeneration: 1, claimedAt: STALE, status: 'applied',
    });
    const platform = recordingBackfillAccessor();

    expect(await recoverStaleInitialBackfillDispatches(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 0 });
    expect(platform.created).toEqual([]);
  });
});

describe('backfill identity', () => {
  it('derives the instance ID the launcher derives', async () => {
    // tests/unit/cover-backfill-launcher.test.ts pins this identical literal
    // against the launcher's copy. Neither derivation may move alone.
    expect(await coverBackfillInstanceId(RUN, JOB, '33333333-3333-4333-8333-333333333333'))
      .toBe('cb1-a07817264cb28dc8a121972f6c5e94f0d2cddca0d93f30f3');
  });

  it('pins only the source-independent version axes', () => {
    expect(coverBackfillDependencyVersions()).toEqual({
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
  });
});

describe('the dispatch-claim clock', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  /**
   * The rolling-minute budget filters `event_cover_workflow_fences.updated_at`
   * against the database's `now`. If the claim stamped that column from the
   * artifact's own clock the two would never be on one timeline: an operator who
   * generated a batch, ran its identity checks and applied it two minutes later
   * would write twenty-five fences already outside the window, and the only
   * bound on the creation rate would report a full minute of headroom however
   * many claims had just landed.
   */
  it('stamps the claim from the database clock, not from the artifact carrying it', async () => {
    const { instanceId, payload } = await seedJob(access, {
      dispatchState: 'pending', dispatchGeneration: 0, fenceGeneration: 0,
    });
    const quoted = (value: string) => `'${value.replace(/'/gu, "''")}'`;
    // Long before this test runs, so a stamp taken from it is unmistakable.
    const generatedAt = '2020-01-01T00:00:00.000Z';

    const claim = claimCoverBackfillDispatchSql({
      binding: quoted('COVER_BACKFILL_WORKFLOW'),
      runId: quoted(payload.runId),
      jobId: quoted(payload.jobId),
      eventId: quoted(payload.eventId),
      generation: '0',
      now: quoted(generatedAt),
      workflowInstanceId: quoted(instanceId),
    }, { inFlight: 25, perMinute: 25 });

    const applied = await testEnv.DB.batch([
      testEnv.DB.prepare(claim.job),
      testEnv.DB.prepare(claim.fence),
    ]);
    expect(applied[0]!.meta.changes).toBe(1);

    const fence = await row<{ updated_at: string; dispatch_generation: number }>(
      'SELECT updated_at, dispatch_generation FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
      instanceId,
    );
    expect(fence.dispatch_generation).toBe(1);
    expect(fence.updated_at).not.toBe(generatedAt);
    // The exact shape the rest of the schema stores, so the window predicate can
    // compare against it byte for byte.
    expect(fence.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    // And the budget can actually see it, which is the whole point.
    expect(await row(`
      SELECT count(*) AS count FROM event_cover_workflow_fences
      WHERE workflow_instance_id = ?1 AND dispatch_generation > 0
        AND updated_at >= ${ROLLING_CLAIM_WINDOW_SQL}
    `, instanceId)).toEqual({ count: 1 });

    const job = await row<{ updated_at: string }>(
      'SELECT updated_at FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    expect(job.updated_at).not.toBe(generatedAt);
    expect(job.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(Math.abs(Date.parse(job.updated_at) - Date.parse(fence.updated_at))).toBeLessThan(1_000);
  });
});

describe('backfill preflight', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('advances a queued job and recomputes the run counters', async () => {
    const { payload } = await seedJob(access);
    const stage = await coverBackfillPreflight(backfillEnv(), payload, now);

    expect(stage.shouldContinue).toBe(true);
    expect(await row('SELECT status FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ status: 'normalizing' });
    expect(await row('SELECT total_count, queued_count FROM event_cover_backfill_runs WHERE id = ?', RUN))
      .toEqual({ total_count: 1, queued_count: 1 });
  });

  it('exits before any Images work when the purge coordinator blocked the fence', async () => {
    const { payload, instanceId } = await seedJob(access);
    // Blocked through the production coordinator rather than by hand: an
    // `unknown` platform reading parks the purge in its fence phase, which is
    // the exact window a late dispatcher arrives in.
    const purge = await reconcileEventCoverPurge(testEnv, access.event.id, now, blockingAccessors());
    expect(purge).toMatchObject({ phase: 'fences', remainder: true });
    expect(await row('SELECT state FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
      instanceId)).toEqual({ state: 'deletion-blocked' });

    const recording = withRecordingImages();
    const stage = await coverBackfillPreflight(recording.env, payload, now);

    // Two independent barriers, and the job row is the earlier one: the same
    // coordinator batch that blocked the fence also made this job terminal, so
    // the instance exits before it reads the fence at all. The fence is what
    // catches an instance whose row is still live — the two cases below.
    expect(stage.outcome).toMatchObject({ status: 'failed', failureCode: 'EVENT_DELETED' });
    expect(recording.calls).toHaveLength(0);
  });

  /**
   * The fence and the claim are two statements, and only the second carries the
   * bounds. A refused claim leaves the first standing, so an instance triggered
   * from the same artifact arrives with an open, generation-matching fence in
   * front of a job nobody ever claimed.
   */
  it('refuses to work for a job whose claim was refused, and writes nothing', async () => {
    const { payload } = await seedJob(access, {
      dispatchState: 'pending', dispatchGeneration: 0, fenceGeneration: 0,
    });

    const recording = withRecordingImages();
    const stage = await coverBackfillPreflight(recording.env, payload, now);

    expect(stage.shouldContinue).toBe(false);
    expect(stage.outcome.status).toBe('skipped');
    expect(recording.calls).toHaveLength(0);
    // Still dispatchable: the next batch must be able to claim it properly.
    expect(await row('SELECT dispatch_state, status FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ dispatch_state: 'pending', status: 'queued' });
  });

  it('refuses to work when no fence exists at all', async () => {
    const { payload, instanceId } = await seedJob(access);
    // A settled purge removes the fence on its own schedule, so absence is what
    // an instance that outlived its fence sees — and absence is refusal, never
    // the "nothing objects" the earlier guard read it as.
    await testEnv.DB.prepare('DELETE FROM event_cover_workflow_fences WHERE workflow_instance_id = ?')
      .bind(instanceId).run();

    const recording = withRecordingImages();
    const stage = await coverBackfillPreflight(recording.env, payload, now);

    expect(stage.outcome).toMatchObject({ status: 'failed', failureCode: 'COVER_RENDER_UNAVAILABLE' });
    expect(recording.calls).toHaveLength(0);
  });

  it('refuses to work for a fence from another dispatch generation', async () => {
    const { payload, instanceId } = await seedJob(access);
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET dispatch_generation = dispatch_generation + 1 WHERE workflow_instance_id = ?
    `).bind(instanceId).run();

    const recording = withRecordingImages();
    const stage = await coverBackfillPreflight(recording.env, payload, now);

    expect(stage.outcome).toMatchObject({ status: 'failed', failureCode: 'COVER_RENDER_UNAVAILABLE' });
    expect(recording.calls).toHaveLength(0);
  });

  it.each([
    ['the revision moved', 'UPDATE events SET cover_revision = 9 WHERE id = ?'],
    ['the host replaced the cover', "UPDATE events SET cover_object_key = 'events/x/cover/other.jpg' WHERE id = ?"],
    ['the host removed the cover', 'UPDATE events SET cover_object_key = NULL WHERE id = ?'],
    ['a later job already converted it', "UPDATE events SET cover_render_set_id = 'set-x' WHERE id = ?"],
    ['the event was deleted', "UPDATE events SET deleted_at = '2026-08-05T00:00:00.000Z' WHERE id = ?"],
  ])('skips rather than overwrites when %s', async (_name, mutation) => {
    const { payload } = await seedJob(access);
    await testEnv.DB.prepare(mutation).bind(access.event.id).run();

    const recording = withRecordingImages();
    const stage = await coverBackfillPreflight(recording.env, payload, now);

    expect(stage.outcome.status).toBe('skipped');
    expect(recording.calls).toHaveLength(0);
    expect(await row('SELECT status, retryable FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ status: 'skipped', retryable: 0 });
  });

  it('returns a terminal job without touching it again', async () => {
    const { payload } = await seedJob(access);
    await testEnv.DB.prepare("UPDATE event_cover_backfill_jobs SET status = 'applied' WHERE id = ?")
      .bind(JOB).run();
    expect((await coverBackfillPreflight(backfillEnv(), payload, now)).outcome.status).toBe('applied');

    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs SET status = 'failed', retryable = 0 WHERE id = ?
    `).bind(JOB).run();
    expect((await coverBackfillPreflight(backfillEnv(), payload, now)).outcome.status).toBe('failed');
  });
});

describe('backfill normalization', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('creates a centred master, freezes the manifest, and allocates the staging set', async () => {
    const { payload } = await seedJob(access);
    const env = backfillEnv();
    await coverBackfillPreflight(env, payload, now);

    const stage = await coverBackfillNormalize(env, payload, now);
    expect(stage.shouldContinue).toBe(true);

    const master = await row<{
      auto_focus_x: number; auto_focus_y: number; composition_model_version: number; width: number;
    }>('SELECT auto_focus_x, auto_focus_y, composition_model_version, width FROM event_cover_masters WHERE event_id = ?',
      access.event.id);
    // Centre focus, because no historic focal point exists to recover.
    expect(master).toMatchObject({ auto_focus_x: 0.5, auto_focus_y: 0.5, composition_model_version: 1 });

    const job = await row<{ status: string; manifest_json: string; manifest_sha256: string; render_set_id: string }>(
      'SELECT status, manifest_json, manifest_sha256, render_set_id FROM event_cover_backfill_jobs WHERE id = ?',
      JOB,
    );
    expect(job.status).toBe('rendering');
    expect(job.manifest_sha256).toMatch(/^[0-9a-f]{64}$/u);
    // A 2400x1600 master qualifies for every 2x profile.
    expect((JSON.parse(job.manifest_json) as { slots: unknown[] }).slots).toHaveLength(24);

    expect(await row('SELECT state, required_slots, draft_id FROM event_cover_render_sets WHERE id = ?', job.render_set_id))
      .toEqual({ state: 'staging', required_slots: 24, draft_id: null });
    // The recipe is the one config a backfill may write: no host intent to invent.
    expect(await row('SELECT recipe_json FROM event_cover_render_sets WHERE id = ?', job.render_set_id))
      .toEqual({ recipe_json: '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}' });
  });

  it('marks a source it cannot normalize as needing replacement and leaves it in place', async () => {
    const { payload, key } = await seedJob(access);
    const env = backfillEnv({ width: 400, height: 300 });
    await coverBackfillPreflight(env, payload, now);

    const stage = await coverBackfillNormalize(env, payload, now);
    expect(stage.outcome).toMatchObject({ status: 'needs_replacement', retryable: false });

    const job = await row<{ status: string; expires_at: string | null; failure_code: string }>(
      'SELECT status, expires_at, failure_code FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    expect(job.status).toBe('needs_replacement');
    expect(job.failure_code).toBe('COVER_SOURCE_TOO_SMALL');
    // It blocks the proof, so it must never age out of the ledger.
    expect(job.expires_at).toBeNull();

    // The event stays exactly as it was, on the compatibility reader.
    const event = (await new EventsRepository(testEnv.DB).getById(access.event.id))!;
    expect(event.coverObjectKey).toBe(key);
    expect(event.coverRenderSetId).toBeNull();
    expect(event.coverRevision).toBe(0);
    expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });

  it('keeps an unavailable renderer retryable rather than blaming the photo', async () => {
    const { payload } = await seedJob(access);
    await coverBackfillPreflight(backfillEnv(), payload, now);

    const withoutImages = { ...testEnv, IMAGES: undefined } as unknown as AppEnv;
    const stage = await coverBackfillNormalize(withoutImages, payload, now);

    expect(stage.outcome).toMatchObject({ status: 'failed', retryable: true });
    expect(await row('SELECT status, retryable, expires_at FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toMatchObject({ status: 'failed', retryable: 1, expires_at: null });
  });

  it('skips when the row changed between preflight and normalization', async () => {
    const { payload } = await seedJob(access);
    const env = backfillEnv();
    await coverBackfillPreflight(env, payload, now);
    await testEnv.DB.prepare('UPDATE events SET cover_revision = 4 WHERE id = ?')
      .bind(access.event.id).run();

    const recording = withRecordingImages();
    expect((await coverBackfillNormalize(recording.env, payload, now)).outcome.status).toBe('skipped');
    expect(recording.calls).toHaveLength(0);
  });
});

describe('backfill profile steps', () => {
  let access: Access;
  let payload: { runId: string; jobId: string; eventId: string };

  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
    payload = (await seedJob(access)).payload;
    const env = backfillEnv();
    await coverBackfillPreflight(env, payload, now);
    await coverBackfillNormalize(env, payload, now);
  });

  it('is individually replay-safe: a second run adopts rather than rewrites', async () => {
    const first = await coverBackfillProfileStep(backfillEnv(), payload, 'wide-expanded', now);
    expect(first).toMatchObject({ profile: 'wide-expanded', written: 4, adopted: 0 });

    const second = withRecordingImages();
    const replay = await coverBackfillProfileStep(second.env, payload, 'wide-expanded', now);
    expect(replay).toMatchObject({ written: 0, adopted: 4 });
    expect(second.calls).toHaveLength(0);
    expect(await row(`
      SELECT count(*) AS count FROM event_cover_render_objects WHERE profile_id = 'wide-expanded'
    `)).toEqual({ count: 4 });
  });

  it('materializes exactly the frozen manifest', async () => {
    await renderEveryProfile(backfillEnv(), payload);
    const job = await row<{ render_set_id: string }>(
      'SELECT render_set_id FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    expect(await row('SELECT count(*) AS count FROM event_cover_render_objects WHERE render_set_id = ?', job.render_set_id))
      .toEqual({ count: 24 });
  });
});

describe('backfill finalize', () => {
  let access: Access;
  let payload: { runId: string; jobId: string; eventId: string };
  let key: string;

  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
    const seeded = await seedJob(access);
    payload = seeded.payload;
    key = seeded.key;
    const env = backfillEnv();
    await coverBackfillPreflight(env, payload, now);
    await coverBackfillNormalize(env, payload, now);
    await renderEveryProfile(env, payload);
  });

  it('swaps the pointers, inventories the original, and never deletes it', async () => {
    const outcome = await coverBackfillFinalize(testEnv, payload, now);
    expect(outcome).toMatchObject({ status: 'applied', appliedRevision: 1 });

    const event = (await new EventsRepository(testEnv.DB).getById(access.event.id))!;
    expect(event.coverRevision).toBe(1);
    expect(event.coverObjectKey).not.toBe(key);
    expect(event.coverObjectKey).toContain('/cover/masters/');
    expect(event.coverRenderSetId).not.toBeNull();
    expect(JSON.parse(event.coverConfig) as unknown).toEqual({
      version: 1, source: { kind: 'upload' }, focus: { mode: 'auto' }, effect: 'natural',
    });

    expect(await row('SELECT state, published_revision FROM event_cover_render_sets WHERE id = ?', event.coverRenderSetId!))
      .toEqual({ state: 'active', published_revision: 1 });
    // Inventoried by the same statements that displaced it, and still in R2.
    expect(await row('SELECT object_key, reason, deleted_at FROM event_cover_retired_legacy_objects WHERE event_id = ?', access.event.id))
      .toEqual({ object_key: key, reason: 'backfilled', deleted_at: null });
    expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();

    const job = await row<{ status: string; reference_release_at: string; expires_at: string }>(
      'SELECT status, reference_release_at, expires_at FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    expect(job.status).toBe('applied');
    expect(job.reference_release_at).toBe('2026-08-12T12:00:00.000Z');
    expect(job.expires_at).toBe('2026-09-04T12:00:00.000Z');
    expect(await row('SELECT expires_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
      (await coverBackfillInstanceId(RUN, JOB, access.event.id))))
      .toEqual({ expires_at: '2026-09-05T12:00:00.000Z' });
    expect(await row('SELECT applied_count, queued_count FROM event_cover_backfill_runs WHERE id = ?', RUN))
      .toEqual({ applied_count: 1, queued_count: 0 });
  });

  it('persists and reuses the backfill ready/finalizing checkpoint before the pointer swap', async () => {
    const pinned = await row<{ render_set_id: string; manifest_sha256: string }>(`
      SELECT render_set_id, manifest_sha256 FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB);
    const beforeEvent = await row(`
      SELECT cover_revision, cover_object_key, cover_render_set_id FROM events WHERE id = ?
    `, access.event.id);

    await expect(coverBackfillFinalize(envAfterFirstBatch(async () => {
      throw new Error('pause after backfill ready checkpoint');
    }), payload, now)).rejects.toThrow('pause after backfill ready checkpoint');

    expect(await row(`
      SELECT status, manifest_sha256, terminal_at FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB)).toEqual({
      status: 'finalizing', manifest_sha256: pinned.manifest_sha256, terminal_at: null,
    });
    expect(await row(`
      SELECT state, manifest_sha256, ready_at, published_revision, published_at
      FROM event_cover_render_sets WHERE id = ?
    `, pinned.render_set_id)).toEqual({
      state: 'ready', manifest_sha256: pinned.manifest_sha256, ready_at: now.toISOString(),
      published_revision: null, published_at: null,
    });
    expect(await row(`
      SELECT cover_revision, cover_object_key, cover_render_set_id FROM events WHERE id = ?
    `, access.event.id)).toEqual(beforeEvent);

    await expect(coverBackfillFinalize(backfillEnvRejectingManifestReads(), payload, now))
      .resolves.toMatchObject({ status: 'applied', appliedRevision: 1 });
  });

  it.each([
    ['applied job', "SET status = 'applied'"],
    ['set activation', "SET state = 'active'"],
  ])('rolls the complete backfill graph back when the %s tail changes zero rows', async (
    _name,
    fragment,
  ) => {
    await expect(coverBackfillFinalize(envAfterFirstBatch(async () => {
      throw new Error('checkpoint only');
    }), payload, now)).rejects.toThrow('checkpoint only');
    const job = await row<{ render_set_id: string }>(
      'SELECT render_set_id FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    const beforeEvent = await row('SELECT * FROM events WHERE id = ?', access.event.id);
    const beforeJob = await row('SELECT * FROM event_cover_backfill_jobs WHERE id = ?', JOB);
    const beforeSet = await row('SELECT * FROM event_cover_render_sets WHERE id = ?', job.render_set_id);
    const fault = zeroBackfillTailEnv(fragment);

    await expect(coverBackfillFinalize(fault.env, payload, now)).rejects.toThrow();

    expect(fault.wasInjected()).toBe(true);
    expect(await row('SELECT * FROM events WHERE id = ?', access.event.id)).toEqual(beforeEvent);
    expect(await row('SELECT * FROM event_cover_backfill_jobs WHERE id = ?', JOB)).toEqual(beforeJob);
    expect(await row('SELECT * FROM event_cover_render_sets WHERE id = ?', job.render_set_id))
      .toEqual(beforeSet);
    expect(await row(`
      SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?
    `, access.event.id)).toEqual({ count: 0 });
  });

  it('moves the revision exactly once across a replay', async () => {
    await coverBackfillFinalize(testEnv, payload, now);
    const replay = await coverBackfillFinalize(testEnv, payload, now);
    expect(replay).toMatchObject({ status: 'applied', appliedRevision: 1 });
    expect((await new EventsRepository(testEnv.DB).getById(access.event.id))!.coverRevision).toBe(1);
  });

  it('yields to a host who changed their cover first', async () => {
    await testEnv.DB.prepare('UPDATE events SET cover_revision = 5 WHERE id = ?')
      .bind(access.event.id).run();

    const outcome = await coverBackfillFinalize(testEnv, payload, now);
    expect(outcome.status).toBe('skipped');

    const event = (await new EventsRepository(testEnv.DB).getById(access.event.id))!;
    expect(event.coverRevision).toBe(5);
    expect(event.coverObjectKey).toBe(key);
    expect(event.coverRenderSetId).toBeNull();
    expect(await row('SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?', access.event.id))
      .toEqual({ count: 0 });
    expect(await row('SELECT status FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ status: 'skipped' });
  });

  it('cannot adopt a competing removal that reached the same next revision', async () => {
    const raced = envBeforeFirstBatch(async () => {
      await testEnv.DB.prepare(`
        UPDATE events
        SET cover_revision = 1, cover_object_key = NULL, cover_render_set_id = NULL
        WHERE id = ?
      `).bind(access.event.id).run();
    });

    const outcome = await coverBackfillFinalize(raced, payload, now);
    expect(outcome.status).toBe('skipped');
    expect(await row(`
      SELECT cover_revision, cover_object_key, cover_render_set_id FROM events WHERE id = ?
    `, access.event.id)).toEqual({
      cover_revision: 1, cover_object_key: null, cover_render_set_id: null,
    });
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
    expect(await row('SELECT status FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ status: 'skipped' });
  });

  it('cannot overwrite a permanent deletion settlement that wins before finalize', async () => {
    const set = await row<{ id: string }>(
      'SELECT render_set_id AS id FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    const raced = envBeforeFirstBatch(async () => {
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_backfill_jobs
          SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED'
          WHERE id = ?
        `).bind(JOB),
        testEnv.DB.prepare(`
          UPDATE event_cover_render_sets SET state = 'abandoned' WHERE id = ?
        `).bind(set.id),
        testEnv.DB.prepare(`
          UPDATE event_cover_workflow_fences SET state = 'deletion-blocked'
          WHERE event_id = ?
        `).bind(access.event.id),
      ]);
    });
    const beforeEvent = await row(`
      SELECT cover_revision, cover_object_key, cover_render_set_id FROM events WHERE id = ?
    `, access.event.id);

    expect(await coverBackfillFinalize(raced, payload, now)).toMatchObject({
      status: 'failed', failureCode: 'EVENT_DELETED', retryable: false,
    });
    expect(await row(`
      SELECT cover_revision, cover_object_key, cover_render_set_id FROM events WHERE id = ?
    `, access.event.id)).toEqual(beforeEvent);
    expect(await row('SELECT state FROM event_cover_render_sets WHERE id = ?', set.id))
      .toEqual({ state: 'abandoned' });
    expect(await row(`
      SELECT status, retryable, failure_code FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB)).toEqual({ status: 'failed', retryable: 0, failure_code: 'EVENT_DELETED' });
  });

  it('refuses to activate an incomplete manifest', async () => {
    await testEnv.DB.prepare("DELETE FROM event_cover_render_objects WHERE profile_id = 'short-lookup'").run();

    const outcome = await coverBackfillFinalize(testEnv, payload, now);
    expect(outcome).toMatchObject({ status: 'failed', retryable: false });

    const event = (await new EventsRepository(testEnv.DB).getById(access.event.id))!;
    expect(event.coverObjectKey).toBe(key);
    expect(event.coverRenderSetId).toBeNull();
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
  });

  it('refuses a frozen manifest whose recorded SHA no longer matches its bytes', async () => {
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs SET manifest_sha256 = ? WHERE id = ?
    `).bind('f'.repeat(64), JOB).run();

    const outcome = await coverBackfillFinalize(testEnv, payload, now);

    expect(outcome).toMatchObject({ status: 'failed', retryable: false });
    expect((await new EventsRepository(testEnv.DB).getById(access.event.id))!.coverObjectKey)
      .toBe(key);
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
  });

  it('refuses a count-preserving substitution outside the frozen tuple set', async () => {
    await resetDatabase();
    access = await eventAccess();
    const seeded = await seedPinnedFailedJob(access);
    payload = seeded.payload;
    key = seeded.key;
    await testEnv.MEDIA_BUCKET.put(
      coverMasterKey(access.event.id, PINNED_MASTER), new Uint8Array(2_000),
    );
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'rendering', failure_code = NULL, retryable = 0,
          terminal_at = NULL, reference_release_at = NULL, expires_at = NULL
      WHERE id = ?
    `).bind(JOB).run();
    await renderEveryProfile(backfillEnv(), payload);
    expect(await row(`
      SELECT count(*) AS count FROM event_cover_render_objects WHERE render_set_id = ?
    `, PINNED_RENDER_SET)).toEqual({ count: 12 });
    await testEnv.DB.prepare(`
      UPDATE event_cover_render_objects
      SET density = '2x', width = 720, height = 336
      WHERE render_set_id = ? AND profile_id = 'short-lookup'
        AND density = '1x' AND format = 'webp'
    `).bind(PINNED_RENDER_SET).run();

    const outcome = await coverBackfillFinalize(testEnv, payload, now);

    expect(outcome).toMatchObject({ status: 'failed', retryable: false });
    expect((await new EventsRepository(testEnv.DB).getById(access.event.id))!.coverObjectKey)
      .toBe(key);
    expect(await row('SELECT state FROM event_cover_render_sets WHERE id = ?', PINNED_RENDER_SET))
      .toEqual({ state: 'abandoned' });
  });
});

describe('platform reconciliation and the guarded restart edge', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  /** A job the ledger believes is running: the ordinary reconciliation subject. */
  const inFlight = (extra: SeedOptions = {}) => seedJob(access, {
    dispatchState: 'confirmed', dispatchGeneration: 1, fenceGeneration: 1,
    status: 'rendering', ...extra,
  });

  /** A retryable platform failure recorded a minute ago, well inside its window. */
  const failedRetryable = (extra: SeedOptions = {}) => seedJob(access, {
    dispatchState: 'confirmed', dispatchGeneration: 1, fenceGeneration: 1,
    status: 'failed', retryable: 1, failureCode: 'COVER_RENDER_UNAVAILABLE',
    terminalAt: new Date(now.getTime() - 60_000), ...extra,
  });

  interface JobShape {
    status: string;
    dispatch_state: string;
    dispatch_generation: number;
    retryable: number;
    failure_code: string | null;
    terminal_at: string | null;
    expires_at: string | null;
    reference_release_at: string | null;
  }

  const currentJob = () => row<JobShape>(`
    SELECT status, dispatch_state, dispatch_generation, retryable, failure_code,
           terminal_at, expires_at, reference_release_at
    FROM event_cover_backfill_jobs WHERE id = ?
  `, JOB);

  const currentFence = (instanceId: string) => row<{ state: string; dispatch_generation: number }>(
    'SELECT state, dispatch_generation FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
    instanceId,
  );

  /* ---------------- the total lookup map ---------------- */

  it.each(['queued', 'running', 'waiting', 'waitingForPause'])(
    'leaves a %s instance untouched', async (status) => {
      const { instanceId } = await inFlight();
      const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status } });

      expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
        inspected: 1, unchanged: 1, resumed: 0, restarted: 0, recreated: 0, failuresRecorded: 0,
      });
      expect(platform.calls).toEqual([`lookup:${instanceId}`]);
      expect(await currentJob()).toMatchObject({
        status: 'rendering', dispatch_state: 'confirmed', dispatch_generation: 1,
      });
    },
  );

  /**
   * Unknown information is never permission to mutate D1 or the platform. Its
   * sole observable effect is one bounded operations event whose source and
   * code come from fixed vocabularies rather than from platform-controlled text.
   */
  it.each<[string, CoverWorkflowLookup | 'throw', string]>([
    [
      'an unmapped status',
      { kind: 'status', status: SENSITIVE_PLATFORM_DETAIL },
      'cover_platform_unmapped',
    ],
    [
      "the platform's own unknown",
      { kind: 'status', status: 'unknown' },
      'cover_platform_unknown',
    ],
    [
      'an unknown lookup with an untrusted label',
      { kind: 'unknown', telemetry: SENSITIVE_PLATFORM_DETAIL },
      'cover_platform_unknown',
    ],
    ['a thrown lookup', 'throw', 'cover_platform_lookup_failed'],
  ])('preserves state and emits only sanitized telemetry for %s', async (
    _name,
    entry,
    expectedCode,
  ) => {
    const { instanceId } = await inFlight();
    const beforeJob = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    const beforeFence = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId,
    );
    const beforeRun = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN,
    );
    const platform = scriptedBackfillAccessor({ [instanceId]: entry });
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
        .toMatchObject({ inspected: 1, unchanged: 1, resumed: 0, restarted: 0, recreated: 0 });
      expect(platform.calls).toEqual([`lookup:${instanceId}`]);
      expect(await row('SELECT * FROM event_cover_backfill_jobs WHERE id = ?', JOB))
        .toEqual(beforeJob);
      expect(await row(
        'SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId,
      )).toEqual(beforeFence);
      expect(await row('SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN))
        .toEqual(beforeRun);

      expect(reported).toHaveBeenCalledTimes(1);
      expect(reported.mock.calls[0]).toHaveLength(1);
      const serialized = String(reported.mock.calls[0]![0]);
      expect(JSON.parse(serialized) as Record<string, unknown>).toEqual({
        event: 'cover_platform_observation',
        source: 'backfill',
        code: expectedCode,
      });
      expect(serialized).not.toContain(SENSITIVE_PLATFORM_DETAIL);
      expect(serialized).not.toContain(instanceId);
    } finally {
      reported.mockRestore();
    }
  });

  /**
   * Resume is the one edge that keeps the instance's completed steps, so it
   * carries none of the restart predicates: no `failed`, no `retryable`, no
   * `terminal_at`. This job has none of the three.
  */
  it('claims, resumes, and confirms a paused instance without a failure record', async () => {
    const { instanceId } = await inFlight({ status: 'normalizing' });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'paused' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
      inspected: 1, resumed: 1, restarted: 0, recreated: 0, failuresRecorded: 0, unchanged: 0,
    });
    expect(platform.calls).toEqual([`lookup:${instanceId}`, `resume:${instanceId}`]);
    // The status is untouched: a resume continues the instance where it stopped.
    expect(await currentJob()).toMatchObject({
      status: 'normalizing', dispatch_state: 'confirmed', dispatch_generation: 2,
    });
    // The fence moved with the job, because a resume *is* a dispatch claim.
    expect(await currentFence(instanceId)).toEqual({ state: 'open', dispatch_generation: 2 });
    expect(await row('SELECT expires_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId))
      .toEqual({ expires_at: FENCE_HOLD });
  });

  it('leaves a refused resume recoverable at its claimed generation', async () => {
    const { instanceId } = await inFlight({ status: 'normalizing' });
    const platform = scriptedBackfillAccessor(
      { [instanceId]: { kind: 'status', status: 'paused' } }, { resume: true },
    );

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, resumed: 0 });
    expect(await currentJob()).toMatchObject({
      status: 'normalizing', dispatch_state: 'resuming', dispatch_generation: 2,
    });
    expect(await currentFence(instanceId)).toEqual({ state: 'open', dispatch_generation: 2 });
  });

  it.each(['errored', 'terminated'])(
    'persists a retryable failure before restarting a %s instance', async (status) => {
      const { instanceId } = await inFlight();
      const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status } });

      expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
        inspected: 1, failuresRecorded: 1, restarted: 1, resumed: 0, unchanged: 0,
      });
      expect(platform.calls).toEqual([`lookup:${instanceId}`, `restart:${instanceId}`]);
      // The claim clears every terminal field it set a moment earlier.
      expect(await currentJob()).toEqual({
        status: 'queued', dispatch_state: 'confirmed', dispatch_generation: 2,
        retryable: 0, failure_code: null, terminal_at: null,
        expires_at: null, reference_release_at: null,
      });
      expect(await currentFence(instanceId)).toEqual({ state: 'open', dispatch_generation: 2 });
      expect(await row('SELECT expires_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId))
        .toEqual({ expires_at: FENCE_HOLD });
    },
  );

  it('treats a complete instance whose job is still nonterminal as a retryable divergence', async () => {
    const { instanceId } = await inFlight();
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'complete' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, failuresRecorded: 1, restarted: 1 });
    expect(await currentJob()).toMatchObject({ status: 'queued', dispatch_generation: 2 });
  });

  it.each(['errored', 'terminated', 'complete'] as const)(
    'immediately restarts a newly observed %s instance at the current D1 clock',
    async (status) => {
      const { instanceId } = await inFlight();
      const clock = await row<{ current_time: string }>(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS current_time",
      );
      const reconciliationTime = new Date(clock.current_time);
      const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status } });

      expect(await reconcileCoverBackfillJobs(testEnv, reconciliationTime, platform.accessor))
        .toMatchObject({ inspected: 1, failuresRecorded: 1, restarted: 1, unchanged: 0 });
      expect(platform.calls).toEqual([`lookup:${instanceId}`, `restart:${instanceId}`]);
      expect(await currentJob()).toMatchObject({
        status: 'queued', dispatch_state: 'confirmed', dispatch_generation: 2,
      });
      expect(await row(`
        SELECT state, dispatch_generation, expires_at
        FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
      `, instanceId)).toEqual({
        state: 'open', dispatch_generation: 2, expires_at: FENCE_HOLD,
      });
      expect(await row(`
        SELECT count(*) AS count FROM event_cover_workflow_fences
        WHERE workflow_instance_id = ?
          AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')
      `, instanceId)).toEqual({ count: 1 });
    },
  );

  it('leaves an already-terminal failed job unchanged when its instance is complete', async () => {
    const { instanceId } = await failedRetryable();
    const before = await currentJob();
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'complete' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
      inspected: 1, resumed: 0, restarted: 0, recreated: 0,
      failuresRecorded: 0, unchanged: 1,
    });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toEqual(before);
  });

  it.each([
    ['active', { kind: 'status', status: 'running' }],
    ['unknown', { kind: 'unknown', telemetry: 'cover_backfill_lookup_failed' }],
  ] as const)('leaves a retryable failed job byte-identical on an %s reading', async (_name, lookup) => {
    const { instanceId } = await failedRetryable();
    const beforeJob = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    const beforeFence = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId,
    );
    const beforeRun = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN,
    );
    const platform = scriptedBackfillAccessor({ [instanceId]: lookup });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, unchanged: 1, resumed: 0, restarted: 0 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await row('SELECT * FROM event_cover_backfill_jobs WHERE id = ?', JOB)).toEqual(beforeJob);
    expect(await row(
      'SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId,
    )).toEqual(beforeFence);
    expect(await row('SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN)).toEqual(beforeRun);
  });

  it('never inspects a job whose ledger row is already terminal', async () => {
    await inFlight({ status: 'applied' });
    const platform = scriptedBackfillAccessor();

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 0 });
    expect(platform.calls).toEqual([]);
  });

  /**
   * Certified absence is unreachable from the real adapter today — its matcher
   * registry is deliberately empty — so this proves the branch a scripted
   * platform can still reach, and that it recreates under the *fenced* ID.
   */
  it('recreates a certified-absent instance under its own fenced ID', async () => {
    const { instanceId } = await inFlight({ status: 'queued' });
    const runBefore = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN,
    );
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'missing' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
      inspected: 1, recreated: 1, restarted: 0, resumed: 0, failuresRecorded: 0,
    });
    expect(platform.calls).toEqual([`lookup:${instanceId}`, `createBatch:${instanceId}`]);
    expect(await currentJob()).toMatchObject({
      status: 'queued', dispatch_state: 'confirmed', dispatch_generation: 2,
    });
    expect(await row('SELECT expires_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId))
      .toEqual({ expires_at: FENCE_HOLD });
    expect(await row('SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN)).toEqual(runBefore);
  });

  it('recreates a certified-absent retryable failure under the same fenced ID', async () => {
    const { instanceId } = await failedRetryable();
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'missing' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
      inspected: 1, recreated: 1, restarted: 0, resumed: 0, failuresRecorded: 0,
    });
    expect(platform.calls).toEqual([`lookup:${instanceId}`, `createBatch:${instanceId}`]);
    expect(await currentJob()).toEqual({
      status: 'queued', dispatch_state: 'confirmed', dispatch_generation: 2,
      retryable: 0, failure_code: null, terminal_at: null,
      expires_at: null, reference_release_at: null,
    });
  });

  it('restores a failed job to normalizing before resuming its paused instance', async () => {
    const { instanceId } = await failedRetryable();
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'paused' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
      inspected: 1, resumed: 1, restarted: 0, recreated: 0, failuresRecorded: 0,
    });
    expect(platform.calls).toEqual([`lookup:${instanceId}`, `resume:${instanceId}`]);
    expect(await currentJob()).toEqual({
      status: 'normalizing', dispatch_state: 'confirmed', dispatch_generation: 2,
      retryable: 0, failure_code: null, terminal_at: null,
      expires_at: null, reference_release_at: null,
    });
    expect(await currentFence(instanceId)).toEqual({ state: 'open', dispatch_generation: 2 });
  });

  it('restores an all-null failed pause at the retained post-preflight normalization seam', async () => {
    const { instanceId, payload } = await failedRetryable();
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'paused' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, resumed: 1, restarted: 0 });
    expect(await currentJob()).toMatchObject({
      status: 'normalizing', dispatch_state: 'confirmed', dispatch_generation: 2,
    });

    const continuation = await coverBackfillNormalize(backfillEnv(), payload, now);
    expect(continuation.shouldContinue).toBe(true);
    expect(await row(`
      SELECT status, master_id, render_set_id, manifest_json, manifest_sha256
      FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB)).toMatchObject({
      status: 'rendering',
      master_id: expect.any(String),
      render_set_id: expect.any(String),
      manifest_json: expect.any(String),
      manifest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('refuses a nonterminal rendering pause whose derived quartet is all null', async () => {
    const { instanceId } = await inFlight({ status: 'rendering' });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'paused' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, resumed: 0, unchanged: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({
      status: 'rendering', dispatch_state: 'confirmed', dispatch_generation: 1,
    });
  });

  it('resumes a valid pinned finalizing pause without changing any pin', async () => {
    const { instanceId } = await seedPinnedFailedJob(access, { adopted: PINNED_MANIFEST_SLOTS });
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'finalizing', retryable = 0, failure_code = NULL, terminal_at = NULL
      WHERE id = ?
    `).bind(JOB).run();
    const pinsBefore = await row<{
      master_id: string; render_set_id: string; manifest_json: string; manifest_sha256: string;
    }>(`
      SELECT master_id, render_set_id, manifest_json, manifest_sha256
      FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB);
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'paused' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, resumed: 1, unchanged: 0 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`, `resume:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'finalizing', dispatch_generation: 2 });
    expect(await row(`
      SELECT master_id, render_set_id, manifest_json, manifest_sha256
      FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB)).toEqual(pinsBefore);
  });

  it('refuses a nonterminal paused claim when a frozen pin drifts after validation', async () => {
    const { instanceId } = await seedPinnedFailedJob(access);
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'rendering', retryable = 0, failure_code = NULL, terminal_at = NULL
      WHERE id = ?
    `).bind(JOB).run();
    const env = envAfterAdoptedTupleRead(async () => {
      await testEnv.DB.prepare(`
        UPDATE event_cover_backfill_jobs SET manifest_sha256 = ? WHERE id = ?
      `).bind('f'.repeat(64), JOB).run();
    });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'paused' } });

    expect(await reconcileCoverBackfillJobs(env, now, platform.accessor))
      .toMatchObject({ inspected: 1, resumed: 0, unchanged: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({
      status: 'rendering', dispatch_state: 'confirmed', dispatch_generation: 1,
    });
  });

  it('refuses recovery when the exact source key changes after fingerprint validation', async () => {
    const { instanceId } = await failedRetryable();
    const replacementKey = `events/${access.event.id}/cover/replaced-after-validation.jpg`;
    const env = envBeforeFirstBatch(async () => {
      await testEnv.DB.prepare(`
        UPDATE events SET cover_object_key = ? WHERE id = ?
      `).bind(replacementKey, access.event.id).run();
    });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'paused' } });

    expect(await reconcileCoverBackfillJobs(env, now, platform.accessor))
      .toMatchObject({ inspected: 1, resumed: 0, unchanged: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({
      status: 'failed', dispatch_state: 'confirmed', dispatch_generation: 1,
    });
  });

  it.each([
    ['restart', 'terminated', 'queued'],
    ['resume', 'paused', 'normalizing'],
  ] as const)(
    'atomically recomputes run counters after a failed-job %s claim',
    async (platformCall, platformStatus, restoredStatus) => {
      const { instanceId } = await failedRetryable();
      await testEnv.DB.prepare(`
        UPDATE event_cover_backfill_runs
        SET total_count = 1, queued_count = 0, failed_count = 1
        WHERE id = ?
      `).bind(RUN).run();
      const platform = scriptedBackfillAccessor({
        [instanceId]: { kind: 'status', status: platformStatus },
      });

      await reconcileCoverBackfillJobs(testEnv, now, platform.accessor);

      expect(platform.calls).toEqual([
        `lookup:${instanceId}`, `${platformCall}:${instanceId}`,
      ]);
      expect(await currentJob()).toMatchObject({ status: restoredStatus });
      expect(await row(`
        SELECT total_count, queued_count, failed_count
        FROM event_cover_backfill_runs WHERE id = ?
      `, RUN)).toEqual({ total_count: 1, queued_count: 1, failed_count: 0 });
    },
  );

  /* ---------------- deletion and fence ownership ---------------- */

  it('settles a job the purge coordinator owns, without contacting the platform', async () => {
    await inFlight();
    await reconcileEventCoverPurge(testEnv, access.event.id, now, blockingAccessors());
    // The coordinator's own batch already made this job terminal. Put it back to
    // a live claim, leaving the coordinator-produced fence untouched, so the
    // reconciler's settlement is the only thing that can move it.
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'rendering', dispatch_state = 'confirmed', failure_code = NULL,
          retryable = 0, terminal_at = NULL WHERE id = ?
    `).bind(JOB).run();
    const platform = scriptedBackfillAccessor();

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
      inspected: 1, blocked: 1, resumed: 0, restarted: 0, recreated: 0,
    });
    expect(platform.calls).toEqual([]);
    expect(await currentJob()).toMatchObject({
      status: 'failed', dispatch_state: 'blocked', failure_code: 'EVENT_DELETED', retryable: 0,
    });
  });

  it('settles a job whose fence was swept out from under it', async () => {
    const { instanceId } = await inFlight();
    await testEnv.DB.prepare('DELETE FROM event_cover_workflow_fences WHERE workflow_instance_id = ?')
      .bind(instanceId).run();
    const platform = scriptedBackfillAccessor();

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, blocked: 1 });
    expect(platform.calls).toEqual([]);
    expect(await currentJob()).toMatchObject({
      status: 'failed', dispatch_state: 'blocked',
      failure_code: 'EVENT_DELETED', retryable: 0,
    });
  });

  it('settles a deletion-blocked fence even when its generation differs', async () => {
    await inFlight({ fenceState: 'deletion-blocked', fenceGeneration: 4 });
    const platform = scriptedBackfillAccessor();

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, blocked: 1, unchanged: 0 });
    expect(platform.calls).toEqual([]);
    expect(await currentJob()).toMatchObject({
      status: 'failed', dispatch_state: 'blocked',
      failure_code: 'EVENT_DELETED', retryable: 0,
    });
  });

  it('settles a deleted event before considering an open fence generation mismatch', async () => {
    await inFlight({ fenceGeneration: 4 });
    await testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
      .bind(now.toISOString(), access.event.id).run();
    const platform = scriptedBackfillAccessor();

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, blocked: 1, unchanged: 0 });
    expect(platform.calls).toEqual([]);
    expect(await currentJob()).toMatchObject({
      status: 'failed', dispatch_state: 'blocked',
      failure_code: 'EVENT_DELETED', retryable: 0,
    });
  });

  it('does not rewrite the run when a newer claim appears after an absent-fence read', async () => {
    const first = await inFlight({
      jobId: '10000000-0000-4000-8000-000000000001', claimedAt: STALE,
    });
    const secondAccess = await eventAccess('Second event');
    const second = await seedJob(secondAccess, {
      runId: RUN, jobId: '20000000-0000-4000-8000-000000000002',
      dispatchState: 'confirmed', dispatchGeneration: 1, fenceGeneration: 1,
      status: 'rendering',
    });
    await testEnv.DB.prepare(`
      DELETE FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(second.instanceId).run();
    const concurrentAt = '2026-08-05T12:00:01.000Z';
    const calls: string[] = [];
    const accessor: CoverBackfillWorkflowAccessor = {
      async lookup(id) {
        calls.push(`lookup:${id}`);
        if (id === first.instanceId) {
          await testEnv.DB.batch([
            testEnv.DB.prepare(`
              UPDATE event_cover_backfill_jobs
              SET dispatch_generation = 2, updated_at = ? WHERE id = ?
            `).bind(concurrentAt, second.payload.jobId),
            testEnv.DB.prepare(`
              INSERT INTO event_cover_workflow_fences (
                workflow_binding, workflow_instance_id, event_id, dispatch_generation,
                state, created_at, updated_at, expires_at
              ) VALUES ('COVER_BACKFILL_WORKFLOW', ?, ?, 2, 'open', ?, ?, ?)
            `).bind(
              second.instanceId, second.payload.eventId,
              concurrentAt, concurrentAt, FENCE_HOLD,
            ),
            testEnv.DB.prepare(`
              UPDATE event_cover_backfill_runs SET updated_at = ? WHERE id = ?
            `).bind(concurrentAt, RUN),
          ]);
        }
        return { kind: 'status', status: 'running' };
      },
      async createBatch() { throw new Error('unreachable'); },
      async resume() { throw new Error('unreachable'); },
      async restart() { throw new Error('unreachable'); },
      async terminate() { throw new Error('unreachable'); },
    };

    expect(await reconcileCoverBackfillJobs(testEnv, now, accessor))
      .toMatchObject({ inspected: 2, blocked: 0, unchanged: 2 });
    expect(calls).toEqual([`lookup:${first.instanceId}`]);
    expect(await row(`
      SELECT status, dispatch_generation FROM event_cover_backfill_jobs WHERE id = ?
    `, second.payload.jobId)).toEqual({ status: 'rendering', dispatch_generation: 2 });
    expect(await row('SELECT updated_at FROM event_cover_backfill_runs WHERE id = ?', RUN))
      .toEqual({ updated_at: concurrentAt });
  });

  /**
   * A fence standing at another generation belongs to another claim, so this is
   * supersession rather than failure. Writing a terminal status here would poison
   * whichever run actually owns the instance.
   */
  it('writes nothing for a fence that belongs to another generation', async () => {
    await inFlight({ fenceGeneration: 4 });
    const platform = scriptedBackfillAccessor();

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, unchanged: 1, blocked: 0 });
    expect(platform.calls).toEqual([]);
    expect(await currentJob()).toMatchObject({
      status: 'rendering', dispatch_state: 'confirmed', dispatch_generation: 1,
    });
  });

  /* ---------------- stale recovery claims ---------------- */

  it('does not select a recovery claim at 119 seconds from its exact open fence clock', async () => {
    const { instanceId } = await seedJob(access, {
      dispatchState: 'resuming', dispatchGeneration: 2, fenceGeneration: 2,
      status: 'normalizing', claimedAt: now,
    });
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs SET updated_at = ? WHERE id = ?
    `).bind('2020-01-01T00:00:00.000Z', JOB).run();
    const platform = scriptedBackfillAccessor({
      [instanceId]: { kind: 'status', status: 'paused' },
    });

    expect(await reconcileCoverBackfillJobs(
      testEnv, new Date(now.getTime() + 119_000), platform.accessor,
    )).toMatchObject({ inspected: 0, resumed: 0 });
    expect(platform.calls).toEqual([]);
  });

  it('selects a recovery claim at 121 seconds from its exact open fence clock', async () => {
    const { instanceId } = await seedJob(access, {
      dispatchState: 'resuming', dispatchGeneration: 2, fenceGeneration: 2,
      status: 'normalizing', claimedAt: now,
    });
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs SET updated_at = ? WHERE id = ?
    `).bind('2040-01-01T00:00:00.000Z', JOB).run();
    const platform = scriptedBackfillAccessor({
      [instanceId]: { kind: 'status', status: 'paused' },
    });

    expect(await reconcileCoverBackfillJobs(
      testEnv, new Date(now.getTime() + 121_000), platform.accessor,
    )).toMatchObject({ inspected: 1, resumed: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`, `resume:${instanceId}`]);
  });

  it('confirms a stale recovery claim whose instance is in fact running', async () => {
    const { instanceId } = await seedJob(access, {
      dispatchState: 'restarting', dispatchGeneration: 2, fenceGeneration: 2,
      status: 'queued', claimedAt: STALE,
    });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'running' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, unchanged: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({
      dispatch_state: 'confirmed', dispatch_generation: 2,
    });
  });

  it('leaves a stale recovery claim byte-identical for an unmapped future status', async () => {
    const { instanceId } = await seedJob(access, {
      dispatchState: 'restarting', dispatchGeneration: 2, fenceGeneration: 2,
      status: 'queued', claimedAt: STALE,
    });
    const beforeJob = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    const beforeFence = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId,
    );
    const beforeRun = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN,
    );
    const platform = scriptedBackfillAccessor({
      [instanceId]: { kind: 'status', status: 'someFutureState' },
    });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, unchanged: 1, resumed: 0, restarted: 0 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await row('SELECT * FROM event_cover_backfill_jobs WHERE id = ?', JOB)).toEqual(beforeJob);
    expect(await row(
      'SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId,
    )).toEqual(beforeFence);
    expect(await row('SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN)).toEqual(beforeRun);
  });

  it('resumes a stale resuming claim whose instance is still paused', async () => {
    const { instanceId } = await seedJob(access, {
      dispatchState: 'resuming', dispatchGeneration: 2, fenceGeneration: 2,
      status: 'normalizing', claimedAt: STALE,
    });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'paused' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, resumed: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`, `resume:${instanceId}`]);
    expect(await currentJob()).toMatchObject({
      status: 'normalizing', dispatch_state: 'confirmed', dispatch_generation: 3,
    });
    expect(await row(`
      SELECT master_id, render_set_id, manifest_json, manifest_sha256
      FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB)).toEqual({
      master_id: null, render_set_id: null, manifest_json: null, manifest_sha256: null,
    });
  });

  /** The platform is never called twice for one claim: a fresh one is not selected. */
  it('leaves a recovery claim it just made alone until it goes stale', async () => {
    await seedJob(access, {
      dispatchState: 'restarting', dispatchGeneration: 2, fenceGeneration: 2, status: 'queued',
    });
    const platform = scriptedBackfillAccessor();

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 0 });
    expect(platform.calls).toEqual([]);
  });

  /**
   * A `creating` claim belongs to initial-create recovery, which replays it
   * without a lookup on purpose. This accessor throws from `lookup`, so a
   * reconciliation that consulted the platform about one would fail loudly.
   */
  it('leaves an initial-create claim to the recovery pass that owns it', async () => {
    await seedJob(access, {
      dispatchState: 'creating', dispatchGeneration: 1, fenceGeneration: 1,
      status: 'queued', claimedAt: STALE,
    });
    const platform = recordingBackfillAccessor();

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 0 });
    expect(platform.created).toEqual([]);
  });

  /* ---------------- every restart predicate ---------------- */

  it('restarts a retryable failure that is still inside its window', async () => {
    const { instanceId } = await failedRetryable();
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'terminated' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
      inspected: 1, restarted: 1, failuresRecorded: 0,
    });
    expect(await currentJob()).toMatchObject({ status: 'queued', dispatch_generation: 2 });
  });

  it('restores a fully adopted frozen manifest at finalizing without changing its pins', async () => {
    const { instanceId } = await seedPinnedFailedJob(access, { adopted: PINNED_MANIFEST_SLOTS });
    const before = await row<{
      master_id: string; render_set_id: string; manifest_json: string; manifest_sha256: string;
    }>(`
      SELECT master_id, render_set_id, manifest_json, manifest_sha256
      FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB);
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'terminated' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`, `restart:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'finalizing', dispatch_generation: 2 });
    expect(await row(`
      SELECT master_id, render_set_id, manifest_json, manifest_sha256
      FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB)).toEqual(before);
  });

  it('restores a frozen manifest with no adopted objects at rendering', async () => {
    const { instanceId } = await seedPinnedFailedJob(access);
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 1 });
    expect(await currentJob()).toMatchObject({ status: 'rendering', dispatch_generation: 2 });
  });

  it('does not count one adopted row as a complete profile', async () => {
    const adopted = PINNED_MANIFEST_SLOTS.filter((slot) => (
      slot.profile !== 'short-lookup' || slot.format === 'webp'
    ));
    const { instanceId } = await seedPinnedFailedJob(access, { adopted });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 1 });
    expect(await currentJob()).toMatchObject({ status: 'rendering', dispatch_generation: 2 });
  });

  it.each([
    ['a malformed manifest shape', JSON.stringify({ slots: 'not-an-array' }), undefined],
    ['a duplicate manifest tuple', JSON.stringify({
      slots: [...PINNED_MANIFEST_SLOTS, PINNED_MANIFEST_SLOTS[0]],
    }), undefined],
    ['an unknown manifest tuple', JSON.stringify({
      slots: [
        ...PINNED_MANIFEST_SLOTS,
        { profile: 'unknown-profile', density: '1x', format: 'webp' },
      ],
    }), undefined],
    ['a manifest missing one mandatory 1x format', JSON.stringify({
      slots: [
        { profile: 'short-lookup', density: '2x', format: 'webp' },
        { profile: 'short-lookup', density: '2x', format: 'jpeg' },
        ...PINNED_MANIFEST_SLOTS.slice(1),
      ],
    }), undefined],
    ['a manifest with only one 2x format', JSON.stringify({
      slots: [
        ...PINNED_MANIFEST_SLOTS,
        { profile: 'short-lookup', density: '2x', format: 'webp' },
      ],
    }), undefined],
    ['an invalid raw manifest digest', PINNED_MANIFEST_JSON, 'f'.repeat(64)],
  ] as const)('refuses restart for %s', async (_name, manifestJson, manifestSha256) => {
    const { instanceId } = await seedPinnedFailedJob(access, { manifestJson, manifestSha256 });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 0, unchanged: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'failed', dispatch_generation: 1 });
  });

  it('refuses restart when an adopted object tuple is not in the frozen manifest', async () => {
    const unexpected = [
      ...PINNED_MANIFEST_SLOTS,
      { profile: 'short-lookup', density: '2x', format: 'webp' },
    ];
    const { instanceId } = await seedPinnedFailedJob(access, { adopted: unexpected });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 0, unchanged: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'failed', dispatch_generation: 1 });
  });

  it('refuses restart when only part of the pinned quartet is present', async () => {
    const { instanceId } = await seedPinnedFailedJob(access);
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs SET manifest_sha256 = NULL WHERE id = ?
    `).bind(JOB).run();
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 0, unchanged: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'failed', dispatch_generation: 1 });
  });

  it('reads at most 24 adopted tuples for the exact render-set and event pair', async () => {
    const { instanceId } = await seedPinnedFailedJob(access);
    const statements: string[] = [];
    const recordingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = { ...testEnv, DB: recordingDb };
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    await reconcileCoverBackfillJobs(env, now, platform.accessor);

    const reads = statements.filter((sql) => (
      sql.trimStart().startsWith('SELECT profile_id, density, format')
    ));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.replace(/\s+/gu, ' ').trim()).toContain(
      'WHERE render_set_id = ? AND event_id = ? ORDER BY profile_id, density, format LIMIT 24',
    );
  });

  it('refuses finalizing when an adopted tuple disappears after the checkpoint read', async () => {
    const { instanceId } = await seedPinnedFailedJob(access, { adopted: PINNED_MANIFEST_SLOTS });
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_runs
      SET total_count = 1, queued_count = 0, failed_count = 1, updated_at = ?
      WHERE id = ?
    `).bind(STALE.toISOString(), RUN).run();
    const runBefore = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN,
    );
    const env = envAfterAdoptedTupleRead(async () => {
      await testEnv.DB.prepare(`
        DELETE FROM event_cover_render_objects
        WHERE render_set_id = ? AND profile_id = 'short-lookup'
          AND density = '1x' AND format = 'jpeg'
      `).bind(PINNED_RENDER_SET).run();
    });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(env, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 0, unchanged: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'failed', dispatch_generation: 1 });
    expect(await row('SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN)).toEqual(runBefore);
  });

  it('refuses rendering when an unexpected tuple appears after the checkpoint read', async () => {
    const { instanceId } = await seedPinnedFailedJob(access);
    const env = envAfterAdoptedTupleRead(async () => {
      await testEnv.DB.prepare(`
        INSERT INTO event_cover_render_objects (
          id, render_set_id, event_id, profile_id, density, format, object_key,
          content_type, byte_size, width, height, quality_rung, sha256, created_at
        ) VALUES ('late-object', ?, ?, 'short-lookup', '2x', 'webp', ?,
          'image/webp', 100, 720, 336, 1, ?, ?)
      `).bind(
        PINNED_RENDER_SET, access.event.id,
        `events/${access.event.id}/cover/rendered/${PINNED_RENDER_SET}/short-lookup-2x.webp`,
        'e'.repeat(64), now.toISOString(),
      ).run();
    });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(env, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 0, unchanged: 1 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'failed', dispatch_generation: 1 });
  });

  it('replays pinned derived work without allocating a replacement master or render set', async () => {
    const { payload, instanceId } = await inFlight({ status: 'queued' });
    const env = backfillEnv();
    await coverBackfillPreflight(env, payload, now);
    await coverBackfillNormalize(env, payload, now);
    await renderEveryProfile(env, payload);
    const before = await row<{
      master_id: string; render_set_id: string; manifest_json: string; manifest_sha256: string;
    }>(`
      SELECT master_id, render_set_id, manifest_json, manifest_sha256
      FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB);
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'failed', retryable = 1, failure_code = 'COVER_RENDER_UNAVAILABLE',
          terminal_at = ?, updated_at = ? WHERE id = ?
    `).bind(new Date(now.getTime() - 60_000).toISOString(), now.toISOString(), JOB).run();
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ restarted: 1 });
    expect((await coverBackfillPreflight(env, payload, now)).shouldContinue).toBe(true);
    expect((await coverBackfillNormalize(env, payload, now)).shouldContinue).toBe(true);
    await renderEveryProfile(env, payload);
    expect(await coverBackfillFinalize(testEnv, payload, now))
      .toMatchObject({ status: 'applied' });

    expect(await row(`
      SELECT master_id, render_set_id, manifest_json, manifest_sha256
      FROM event_cover_backfill_jobs WHERE id = ?
    `, JOB)).toEqual(before);
    expect(await row('SELECT count(*) AS count FROM event_cover_masters WHERE event_id = ?', access.event.id))
      .toEqual({ count: 1 });
    expect(await row('SELECT count(*) AS count FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ count: 1 });
  });

  it.each<[string, SeedOptions]>([
    ['it fell out of its restart window', {
      terminalAt: new Date(now.getTime() - BACKFILL_RESTART_WINDOW_MS - 1000),
    }],
    ['the failure was never retryable', { retryable: 0 }],
  ])('never selects a failed job when %s', async (_name, extra) => {
    await failedRetryable(extra);
    const platform = scriptedBackfillAccessor();

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 0 });
    expect(platform.calls).toEqual([]);
  });

  it.each<[string, string]>([
    ['the host replaced the cover', "UPDATE events SET cover_object_key = 'events/x/cover/other.jpg' WHERE id = ?"],
    ['the host removed the cover', 'UPDATE events SET cover_object_key = NULL WHERE id = ?'],
    ['the revision moved', 'UPDATE events SET cover_revision = 9 WHERE id = ?'],
    ['a later job already converted it', "UPDATE events SET cover_render_set_id = 'set-x' WHERE id = ?"],
  ])('refuses the restart when %s', async (_name, mutation) => {
    const { instanceId } = await failedRetryable();
    await testEnv.DB.prepare(mutation).bind(access.event.id).run();
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 0 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'failed', retryable: 1 });
  });

  it('refuses the restart when the pinned dependency versions have moved', async () => {
    const { instanceId } = await failedRetryable({
      dependencyVersions: { ...coverBackfillDependencyVersions(), normalizationLadder: 99 },
    });
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 0 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'failed', retryable: 1 });
  });

  it('refuses the restart when the frozen manifest no longer matches its digest', async () => {
    const { instanceId } = await failedRetryable();
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET manifest_json = '{"slots":[]}', manifest_sha256 = ? WHERE id = ?
    `).bind('b'.repeat(64), JOB).run();
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 0 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'failed', retryable: 1 });
  });

  it('refuses the restart when the rolling minute is already spent', async () => {
    const { instanceId } = await failedRetryable();
    const expiresAt = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString();
    await testEnv.DB.batch(
      Array.from({ length: MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE }, (_unused, index) => testEnv.DB
        .prepare(`
          INSERT INTO event_cover_workflow_fences (
            workflow_binding, workflow_instance_id, event_id, dispatch_generation, state,
            created_at, updated_at, expires_at
          ) VALUES ('COVER_BACKFILL_WORKFLOW', ?, ?, 1, 'open', ?,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
        `).bind(`budget-${index}`, access.event.id, now.toISOString(), expiresAt)),
    );
    const platform = scriptedBackfillAccessor({ [instanceId]: { kind: 'status', status: 'errored' } });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor))
      .toMatchObject({ inspected: 1, restarted: 0 });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await currentJob()).toMatchObject({ status: 'failed', retryable: 1 });
  });

  it('leaves a recovery byte-identical when twenty-five other live jobs fill capacity', async () => {
    const { instanceId } = await inFlight({ status: 'normalizing' });
    await seedOtherLiveBackfillJobs(MAX_COVER_BACKFILL_IN_FLIGHT);
    const beforeJob = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    const beforeFence = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId,
    );
    const beforeRun = await row<Record<string, unknown>>(
      'SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN,
    );
    const platform = scriptedBackfillAccessor({
      [instanceId]: { kind: 'status', status: 'paused' },
    });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
      inspected: 1, resumed: 0, restarted: 0, recreated: 0, unchanged: 1,
    });
    expect(platform.calls).toEqual([`lookup:${instanceId}`]);
    expect(await row('SELECT * FROM event_cover_backfill_jobs WHERE id = ?', JOB)).toEqual(beforeJob);
    expect(await row(
      'SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?', instanceId,
    )).toEqual(beforeFence);
    expect(await row('SELECT * FROM event_cover_backfill_runs WHERE id = ?', RUN)).toEqual(beforeRun);
  });

  it('allows a capacity-neutral recovery beside twenty-four other live jobs', async () => {
    const { instanceId } = await inFlight({ status: 'normalizing' });
    await seedOtherLiveBackfillJobs(MAX_COVER_BACKFILL_IN_FLIGHT - 1);
    const platform = scriptedBackfillAccessor({
      [instanceId]: { kind: 'status', status: 'paused' },
    });

    expect(await reconcileCoverBackfillJobs(testEnv, now, platform.accessor)).toMatchObject({
      inspected: 1, resumed: 1, restarted: 0, recreated: 0, unchanged: 0,
    });
    expect(platform.calls).toEqual([`lookup:${instanceId}`, `resume:${instanceId}`]);
    expect(await currentJob()).toMatchObject({
      status: 'normalizing', dispatch_state: 'confirmed', dispatch_generation: 2,
    });
  });

  it('leaves a refused restart recoverable rather than terminal', async () => {
    const { instanceId } = await inFlight();
    const platform = scriptedBackfillAccessor(
      { [instanceId]: { kind: 'status', status: 'errored' } }, { restart: true },
    );

    const callerNow = new Date('2040-01-01T00:00:00.000Z');

    expect(await reconcileCoverBackfillJobs(testEnv, callerNow, platform.accessor))
      .toMatchObject({ inspected: 1, failuresRecorded: 1, restarted: 0 });
    // The claim stands, so the next pass finds it as a stale recovery claim.
    expect(await currentJob()).toMatchObject({
      status: 'queued', dispatch_state: 'restarting', dispatch_generation: 2,
    });
    const claimClocks = await row<{ job_updated_at: string; fence_updated_at: string }>(`
      SELECT j.updated_at AS job_updated_at, f.updated_at AS fence_updated_at
      FROM event_cover_backfill_jobs j
      JOIN event_cover_workflow_fences f
        ON f.workflow_instance_id = j.workflow_instance_id AND f.event_id = j.event_id
      WHERE j.id = ?
    `, JOB);
    expect(claimClocks.job_updated_at).not.toBe(callerNow.toISOString());
    expect(claimClocks.fence_updated_at).not.toBe(callerNow.toISOString());
    expect(Math.abs(
      Date.parse(claimClocks.job_updated_at) - Date.parse(claimClocks.fence_updated_at),
    )).toBeLessThan(1_000);
  });
});

describe('superseded jobs and the zero-legacy proof', () => {
  let access: Access;
  let payload: { runId: string; jobId: string; eventId: string };

  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
    payload = (await seedJob(access)).payload;
  });

  it('keeps a needs_replacement job red while its exact source is still current', async () => {
    const env = backfillEnv({ width: 400, height: 300 });
    await coverBackfillPreflight(env, payload, now);
    await coverBackfillNormalize(env, payload, now);

    expect(await resolveSupersededBackfillJobsBounded(testEnv, now)).toEqual({
      inspectedJobs: 1,
      resolvedJobs: 0,
      closedVerifiedRuns: 0,
      closedFailedRuns: 0,
      expiredRunsStamped: 0,
      remainder: true,
    });
    expect(await row('SELECT status FROM event_cover_backfill_jobs WHERE id = ?', JOB))
      .toEqual({ status: 'needs_replacement' });
    expect((await proveZeroLegacyCovers(testEnv)).proven).toBe(false);
    expect((await proveZeroLegacyCovers(testEnv)).blockingJobs).toBe(1);
  });

  it('resolves it once the host replaced or removed that cover themselves', async () => {
    const env = backfillEnv({ width: 400, height: 300 });
    await coverBackfillPreflight(env, payload, now);
    await coverBackfillNormalize(env, payload, now);

    await testEnv.DB.prepare('UPDATE events SET cover_object_key = NULL WHERE id = ?')
      .bind(access.event.id).run();
    expect(await resolveSupersededBackfillJobsBounded(testEnv, now)).toEqual({
      inspectedJobs: 1,
      resolvedJobs: 1,
      closedVerifiedRuns: 0,
      closedFailedRuns: 0,
      expiredRunsStamped: 0,
      remainder: false,
    });

    const job = await row<{ status: string; expires_at: string }>(
      'SELECT status, expires_at FROM event_cover_backfill_jobs WHERE id = ?', JOB,
    );
    expect(job.status).toBe('resolved');
    expect(job.expires_at).toBe('2026-09-04T12:00:00.000Z');
    expect(await row('SELECT resolved_count, needs_replacement_count FROM event_cover_backfill_runs WHERE id = ?', RUN))
      .toEqual({ resolved_count: 1, needs_replacement_count: 0 });

    const proof = await proveZeroLegacyCovers(testEnv);
    expect(proof).toMatchObject({ legacyRows: 0, blockingJobs: 0, proven: true });
  });

  it('uses the ID tie-break while rotating 100 blockers so the 101st is reached next', async () => {
    await resetDatabase();
    const current = await eventAccess('Current source');
    const superseded = await eventAccess('Superseded source');
    const currentKey = legacyKey(current.event.id);
    await testEnv.DB.prepare(`
      UPDATE events SET cover_object_key = ?, cover_revision = 9 WHERE id = ?
    `).bind(currentKey, current.event.id).run();
    const fingerprint = await coverKeyFingerprint(currentKey);
    const blockers = Array.from({ length: 100 }, (_unused, index): LedgerSeed => ({
      runId: `fair-run-${index.toString().padStart(3, '0')}`,
      jobId: `fair-job-${index.toString().padStart(3, '0')}`,
      eventId: current.event.id,
      fingerprint,
      expectedRevision: 1,
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCode: 'COVER_SOURCE_NEEDS_REPLACEMENT',
    }));
    await seedLedgerRows([
      ...blockers,
      {
        runId: 'fair-run-superseded',
        jobId: 'fair-job-superseded',
        eventId: superseded.event.id,
        fingerprint,
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);

    const before = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_backfill_jobs WHERE id LIKE 'fair-job-0%' ORDER BY id
    `).all<Record<string, unknown>>();
    const first = await resolveSupersededBackfillJobsBounded(testEnv, now);

    expect(first).toEqual({
      inspectedJobs: 100,
      resolvedJobs: 0,
      closedVerifiedRuns: 0,
      closedFailedRuns: 0,
      expiredRunsStamped: 0,
      remainder: true,
    });
    const after = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_backfill_jobs WHERE id LIKE 'fair-job-0%' ORDER BY id
    `).all<Record<string, unknown>>();
    expect(after.results).toHaveLength(100);
    for (const [index, currentRow] of after.results.entries()) {
      const original = before.results[index]!;
      expect({ ...currentRow, updated_at: original.updated_at }).toEqual(original);
      expect(Date.parse(String(currentRow.updated_at))).toBeGreaterThan(now.getTime());
      expect(Date.parse(String(currentRow.updated_at))).toBeGreaterThan(
        Date.parse(String(original.updated_at)),
      );
    }
    expect(await row<{ status: string }>(
      'SELECT status FROM event_cover_backfill_jobs WHERE id = ?', 'fair-job-superseded',
    )).toEqual({ status: 'needs_replacement' });

    const second = await resolveSupersededBackfillJobsBounded(testEnv, now);
    expect(second).toMatchObject({ inspectedJobs: 100, resolvedJobs: 1, remainder: true });
    expect(await row<{ status: string }>(
      'SELECT status FROM event_cover_backfill_jobs WHERE id = ?', 'fair-job-superseded',
    )).toEqual({ status: 'resolved' });
  });

  it('loses the rotation CAS when the observed event snapshot changes after classification', async () => {
    await resetDatabase();
    const current = await eventAccess('Rotation race');
    const key = legacyKey(current.event.id);
    await testEnv.DB.prepare(`
      UPDATE events SET cover_object_key = ?, cover_revision = 3 WHERE id = ?
    `).bind(key, current.event.id).run();
    const updatedAt = '2026-08-01T00:00:00.000Z';
    await seedLedgerRows([{
      runId: 'rotation-race-run', jobId: 'rotation-race-job', eventId: current.event.id,
      fingerprint: await coverKeyFingerprint(key), expectedRevision: 1, updatedAt,
    }]);
    const racingEnv = envBeforeFirstLedgerWrite(async () => {
      await testEnv.DB.prepare('UPDATE events SET cover_revision = 4 WHERE id = ?')
        .bind(current.event.id).run();
    });

    expect(await resolveSupersededBackfillJobsBounded(racingEnv, now)).toMatchObject({
      inspectedJobs: 1, resolvedJobs: 0, remainder: true,
    });
    expect(await row<{ status: string; updated_at: string }>(`
      SELECT status, updated_at FROM event_cover_backfill_jobs WHERE id = ?
    `, 'rotation-race-job')).toEqual({ status: 'needs_replacement', updated_at: updatedAt });
  });

  it('loses the resolution CAS when the observed event snapshot changes after classification', async () => {
    await resetDatabase();
    const superseded = await eventAccess('Resolution race');
    const updatedAt = '2026-08-01T00:00:00.000Z';
    await seedLedgerRows([{
      runId: 'resolution-race-run', jobId: 'resolution-race-job',
      eventId: superseded.event.id, fingerprint: 'a'.repeat(64), updatedAt,
    }]);
    const racingEnv = envBeforeFirstLedgerWrite(async () => {
      await testEnv.DB.prepare('UPDATE events SET cover_revision = cover_revision + 1 WHERE id = ?')
        .bind(superseded.event.id).run();
    });

    expect(await resolveSupersededBackfillJobsBounded(racingEnv, now)).toMatchObject({
      inspectedJobs: 1, resolvedJobs: 0, remainder: true,
    });
    expect(await row<{ status: string; updated_at: string }>(`
      SELECT status, updated_at FROM event_cover_backfill_jobs WHERE id = ?
    `, 'resolution-race-job')).toEqual({ status: 'needs_replacement', updated_at: updatedAt });
  });

  it('loses the resolution CAS when the selected job fingerprint changes', async () => {
    await resetDatabase();
    const superseded = await eventAccess('Job race');
    const updatedAt = '2026-08-01T00:00:00.000Z';
    await seedLedgerRows([{
      runId: 'job-race-run', jobId: 'job-race-job', eventId: superseded.event.id,
      fingerprint: 'a'.repeat(64), updatedAt,
    }]);
    const racingEnv = envBeforeFirstLedgerWrite(async () => {
      await testEnv.DB.prepare(`
        UPDATE event_cover_backfill_jobs SET legacy_key_fingerprint = ? WHERE id = ?
      `).bind('b'.repeat(64), 'job-race-job').run();
    });

    expect(await resolveSupersededBackfillJobsBounded(racingEnv, now)).toMatchObject({
      inspectedJobs: 1, resolvedJobs: 0, remainder: true,
    });
    expect(await row<{ status: string; updated_at: string }>(`
      SELECT status, updated_at FROM event_cover_backfill_jobs WHERE id = ?
    `, 'job-race-job')).toEqual({ status: 'needs_replacement', updated_at: updatedAt });
  });

  it('recounts an actually changed run once and stamps only the fence whose job won its CAS', async () => {
    await resetDatabase();
    const firstEvent = await eventAccess('First superseded job');
    const secondEvent = await eventAccess('Second superseded job');
    const thirdEvent = await eventAccess('Third superseded job');
    const originalUpdatedAt = '2026-08-01T00:00:00.000Z';
    const runId = 'atomic-resolve-run';
    await seedLedgerRows([
      {
        runId, jobId: 'atomic-resolve-a', eventId: firstEvent.event.id,
        fingerprint: 'a'.repeat(64), updatedAt: originalUpdatedAt, fence: true,
      },
      {
        runId, jobId: 'atomic-resolve-b', eventId: secondEvent.event.id,
        fingerprint: 'b'.repeat(64), updatedAt: originalUpdatedAt, fence: true,
      },
      {
        runId, jobId: 'atomic-resolve-c', eventId: thirdEvent.event.id,
        fingerprint: 'c'.repeat(64), updatedAt: originalUpdatedAt, fence: true,
      },
    ]);
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_runs
      SET total_count = 3, needs_replacement_count = 3 WHERE id = ?
    `).bind(runId).run();
    await testEnv.DB.prepare(`
      CREATE TABLE task5_run_recount_audit (run_id TEXT NOT NULL)
    `).run();
    await testEnv.DB.prepare(`
      CREATE TRIGGER task5_run_recount_once
      AFTER UPDATE ON event_cover_backfill_runs
      WHEN NEW.id = '${runId}'
      BEGIN INSERT INTO task5_run_recount_audit (run_id) VALUES (NEW.id); END
    `).run();
    const racingEnv = envBeforeFirstLedgerWrite(async () => {
      await testEnv.DB.prepare('UPDATE events SET cover_revision = 1 WHERE id = ?')
        .bind(secondEvent.event.id).run();
    });

    expect(await resolveSupersededBackfillJobsBounded(racingEnv, now)).toMatchObject({
      inspectedJobs: 3, resolvedJobs: 2, remainder: true,
    });
    expect(await row(`
      SELECT total_count, resolved_count, needs_replacement_count, updated_at
      FROM event_cover_backfill_runs WHERE id = ?
    `, runId)).toEqual({
      total_count: 3, resolved_count: 2, needs_replacement_count: 1,
      updated_at: now.toISOString(),
    });
    expect(await row<{ count: number }>(
      'SELECT count(*) AS count FROM task5_run_recount_audit WHERE run_id = ?', runId,
    )).toEqual({ count: 1 });
    expect(await row(`
      SELECT status, terminal_at, reference_release_at, expires_at
      FROM event_cover_backfill_jobs WHERE id = ?
    `, 'atomic-resolve-a')).toEqual({
      status: 'resolved',
      terminal_at: now.toISOString(),
      reference_release_at: '2026-08-12T12:00:00.000Z',
      expires_at: '2026-09-04T12:00:00.000Z',
    });
    expect(await row(`
      SELECT status, updated_at FROM event_cover_backfill_jobs WHERE id = ?
    `, 'atomic-resolve-b')).toEqual({
      status: 'needs_replacement', updated_at: originalUpdatedAt,
    });
    expect(await row(`
      SELECT updated_at, expires_at FROM event_cover_workflow_fences
      WHERE workflow_instance_id = ?
    `, 'instance-atomic-resolve-a')).toEqual({
      updated_at: now.toISOString(), expires_at: '2026-09-05T12:00:00.000Z',
    });
    expect(await row(`
      SELECT updated_at, expires_at FROM event_cover_workflow_fences
      WHERE workflow_instance_id = ?
    `, 'instance-atomic-resolve-b')).toEqual({
      updated_at: originalUpdatedAt, expires_at: FENCE_HOLD,
    });
    expect(await row(`
      SELECT updated_at, expires_at FROM event_cover_workflow_fences
      WHERE workflow_instance_id = ?
    `, 'instance-atomic-resolve-c')).toEqual({
      updated_at: now.toISOString(), expires_at: '2026-09-05T12:00:00.000Z',
    });
  });

  it('rolls a job resolution back when its atomic run recount fails', async () => {
    await resetDatabase();
    const superseded = await eventAccess('Atomic rollback');
    const runId = 'atomic-rollback-run';
    const jobId = 'atomic-rollback-job';
    const updatedAt = '2026-08-01T00:00:00.000Z';
    await seedLedgerRows([{
      runId, jobId, eventId: superseded.event.id, fingerprint: 'a'.repeat(64),
      updatedAt, fence: true,
    }]);
    await testEnv.DB.prepare(`
      CREATE TRIGGER task5_recount_abort BEFORE UPDATE ON event_cover_backfill_runs
      WHEN NEW.id = '${runId}' BEGIN SELECT RAISE(ABORT, 'forced recount failure'); END
    `).run();

    await expect(resolveSupersededBackfillJobsBounded(testEnv, now))
      .rejects.toThrow(/forced recount failure/u);
    expect(await row(`
      SELECT status, updated_at FROM event_cover_backfill_jobs WHERE id = ?
    `, jobId)).toEqual({ status: 'needs_replacement', updated_at: updatedAt });
    expect(await row(`
      SELECT updated_at, expires_at FROM event_cover_workflow_fences
      WHERE workflow_instance_id = ?
    `, `instance-${jobId}`)).toEqual({ updated_at: updatedAt, expires_at: FENCE_HOLD });
  });

  it('recounts a resolved run even when the job has no matching fence', async () => {
    await resetDatabase();
    const superseded = await eventAccess('No retained fence');
    const runId = 'missing-fence-recount-run';
    await seedLedgerRows([{
      runId, jobId: 'missing-fence-recount-job', eventId: superseded.event.id,
      fingerprint: 'a'.repeat(64), updatedAt: '2026-08-01T00:00:00.000Z',
    }]);

    expect(await resolveSupersededBackfillJobsBounded(testEnv, now)).toMatchObject({
      inspectedJobs: 1, resolvedJobs: 1, remainder: false,
    });
    expect(await row(`
      SELECT resolved_count, needs_replacement_count, updated_at
      FROM event_cover_backfill_runs WHERE id = ?
    `, runId)).toEqual({
      resolved_count: 1, needs_replacement_count: 0, updated_at: now.toISOString(),
    });
  });

  it('requires a confirming empty pass after exactly 100 resolved jobs', async () => {
    await resetDatabase();
    const superseded = await eventAccess('One hundred superseded jobs');
    await seedLedgerRows(Array.from({ length: 100 }, (_unused, index): LedgerSeed => ({
      runId: `saturated-run-${index.toString().padStart(3, '0')}`,
      jobId: `saturated-job-${index.toString().padStart(3, '0')}`,
      eventId: superseded.event.id,
      fingerprint: 'a'.repeat(64),
      updatedAt: '2026-08-01T00:00:00.000Z',
    })));

    expect(await resolveSupersededBackfillJobsBounded(testEnv, now)).toMatchObject({
      inspectedJobs: 100, resolvedJobs: 100, remainder: true,
    });
    expect(await resolveSupersededBackfillJobsBounded(testEnv, now)).toEqual({
      inspectedJobs: 0,
      resolvedJobs: 0,
      closedVerifiedRuns: 0,
      closedFailedRuns: 0,
      expiredRunsStamped: 0,
      remainder: false,
    });
  });

  it('keeps 99 current blockers pending and preserves every field except the fairness clock', async () => {
    await resetDatabase();
    const current = await eventAccess('Ninety-nine current jobs');
    const key = legacyKey(current.event.id);
    await testEnv.DB.prepare(`
      UPDATE events SET cover_object_key = ?, cover_revision = 17 WHERE id = ?
    `).bind(key, current.event.id).run();
    const fingerprint = await coverKeyFingerprint(key);
    const updatedAt = '2026-08-01T00:00:00.000Z';
    await seedLedgerRows(Array.from({ length: 99 }, (_unused, index): LedgerSeed => ({
      runId: `current-run-${index.toString().padStart(3, '0')}`,
      jobId: `current-job-${index.toString().padStart(3, '0')}`,
      eventId: current.event.id,
      fingerprint,
      expectedRevision: 2,
      updatedAt,
      status: index >= 97 ? 'failed' : 'needs_replacement',
      retryable: index === 98 ? 1 : 0,
      failureCode: index === 98
        ? 'COVER_RENDER_UNAVAILABLE'
        : index === 97 ? 'COVER_SOURCE_UNSUPPORTED' : 'COVER_SOURCE_NEEDS_REPLACEMENT',
      terminalAt: index === 98
        ? '2026-08-05T11:00:00.000Z'
        : index === 97 ? '2026-07-01T00:00:00.000Z' : null,
      referenceReleaseAt: index === 97 ? '2026-07-08T00:00:00.000Z' : null,
      expiresAt: index === 97 ? '2026-07-31T00:00:00.000Z' : null,
    })));
    const before = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_backfill_jobs WHERE id LIKE 'current-job-%' ORDER BY id
    `).all<Record<string, unknown>>();

    expect(await resolveSupersededBackfillJobsBounded(testEnv, now)).toMatchObject({
      inspectedJobs: 99, resolvedJobs: 0, remainder: true,
    });
    const after = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_backfill_jobs WHERE id LIKE 'current-job-%' ORDER BY id
    `).all<Record<string, unknown>>();
    for (const [index, currentRow] of after.results.entries()) {
      const original = before.results[index]!;
      expect({ ...currentRow, updated_at: original.updated_at }).toEqual(original);
      expect(currentRow.updated_at).toBe('2026-08-05T12:00:00.001Z');
    }
    expect(after.results[98]).toMatchObject({
      status: 'failed', retryable: 1, failure_code: 'COVER_RENDER_UNAVAILABLE',
      terminal_at: '2026-08-05T11:00:00.000Z',
      reference_release_at: null, expires_at: null,
    });
    expect(after.results[97]).toMatchObject({
      status: 'failed', retryable: 0, failure_code: 'COVER_SOURCE_UNSUPPORTED',
      terminal_at: '2026-07-01T00:00:00.000Z',
      reference_release_at: '2026-07-08T00:00:00.000Z',
      expires_at: '2026-07-31T00:00:00.000Z',
    });
    expect(await row<{ updated_at: string }>(`
      SELECT updated_at FROM event_cover_backfill_runs WHERE id = ?
    `, 'current-run-000')).toEqual({ updated_at: updatedAt });
  });

  it('resolves every failed currentness predicate on a retained event', async () => {
    await resetDatabase();
    const deleted = await eventAccess('Deleted source');
    const noKey = await eventAccess('Removed source');
    const rendered = await eventAccess('Rendered source');
    const replaced = await eventAccess('Fingerprint changed');
    const deletedKey = legacyKey(deleted.event.id);
    const replacedKey = legacyKey(replaced.event.id);
    await testEnv.DB.prepare(`
      UPDATE events SET cover_object_key = ?, deleted_at = ? WHERE id = ?
    `).bind(deletedKey, now.toISOString(), deleted.event.id).run();
    await seedEventCoverGraph(testEnv.DB, rendered.event.id);
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
      .bind(replacedKey, replaced.event.id).run();
    const originalTerminalAt = '2026-08-05T11:00:00.000Z';
    const updatedAt = '2026-08-01T00:00:00.000Z';
    await seedLedgerRows([
      {
        runId: 'reason-deleted-run', jobId: 'reason-deleted-job', eventId: deleted.event.id,
        fingerprint: await coverKeyFingerprint(deletedKey), updatedAt,
        status: 'failed', retryable: 1, terminalAt: originalTerminalAt, fence: true,
      },
      {
        runId: 'reason-no-key-run', jobId: 'reason-no-key-job', eventId: noKey.event.id,
        fingerprint: 'a'.repeat(64), updatedAt,
      },
      {
        runId: 'reason-rendered-run', jobId: 'reason-rendered-job', eventId: rendered.event.id,
        fingerprint: 'b'.repeat(64), updatedAt,
      },
      {
        runId: 'reason-fingerprint-run', jobId: 'reason-fingerprint-job',
        eventId: replaced.event.id, fingerprint: 'c'.repeat(64), updatedAt,
      },
    ]);
    expect(await resolveSupersededBackfillJobsBounded(testEnv, now)).toMatchObject({
      inspectedJobs: 4, resolvedJobs: 4, remainder: false,
    });
    expect((await testEnv.DB.prepare(`
      SELECT id, status FROM event_cover_backfill_jobs WHERE id LIKE 'reason-%'
      ORDER BY id
    `).all<{ id: string; status: string }>()).results)
      .toEqual([
        { id: 'reason-deleted-job', status: 'resolved' },
        { id: 'reason-fingerprint-job', status: 'resolved' },
        { id: 'reason-no-key-job', status: 'resolved' },
        { id: 'reason-rendered-job', status: 'resolved' },
      ]);
    expect(await row(`
      SELECT terminal_at, reference_release_at, expires_at
      FROM event_cover_backfill_jobs WHERE id = ?
    `, 'reason-deleted-job')).toEqual({
      terminal_at: originalTerminalAt,
      reference_release_at: '2026-08-12T12:00:00.000Z',
      expires_at: '2026-09-04T12:00:00.000Z',
    });
    expect(await row(`
      SELECT updated_at, expires_at FROM event_cover_workflow_fences
      WHERE workflow_instance_id = 'instance-reason-deleted-job'
    `)).toEqual({
      updated_at: now.toISOString(), expires_at: '2026-09-05T12:00:00.000Z',
    });
  });

  it('does not confuse an observed missing event with an existing all-null event snapshot', async () => {
    await resetDatabase();
    const existing = await eventAccess('Existing null snapshot');
    const updatedAt = '2026-08-01T00:00:00.000Z';
    await seedLedgerRows([{
      runId: 'existence-sentinel-run', jobId: 'existence-sentinel-job',
      eventId: existing.event.id, fingerprint: 'a'.repeat(64), updatedAt,
    }]);
    const staleMissingRead = envWithLedgerReadTransform((rows) => rows.map((candidate) => ({
      ...candidate,
      event_exists: 0,
    })));

    expect(await resolveSupersededBackfillJobsBounded(staleMissingRead, now)).toMatchObject({
      inspectedJobs: 1, resolvedJobs: 0, remainder: true,
    });
    expect(await row(`
      SELECT status, updated_at FROM event_cover_backfill_jobs WHERE id = ?
    `, 'existence-sentinel-job')).toEqual({
      status: 'needs_replacement', updated_at: updatedAt,
    });
  });

  it('is red while any legacy row remains', async () => {
    const proof = await proveZeroLegacyCovers(testEnv);
    expect(proof.legacyRows).toBe(1);
    expect(proof.proven).toBe(false);
  });

  it('is green once the row is converted', async () => {
    const env = backfillEnv();
    await coverBackfillPreflight(env, payload, now);
    await coverBackfillNormalize(env, payload, now);
    await renderEveryProfile(env, payload);
    await coverBackfillFinalize(testEnv, payload, now);

    const proof = await proveZeroLegacyCovers(testEnv);
    expect(proof).toEqual({
      legacyRows: 0,
      blockingJobs: 0,
      incompleteActiveSets: 0,
      uploadsWithoutActiveSet: 0,
      proven: true,
    });
  });

  it('catches an active set whose manifest is short', async () => {
    const env = backfillEnv();
    await coverBackfillPreflight(env, payload, now);
    await coverBackfillNormalize(env, payload, now);
    await renderEveryProfile(env, payload);
    await coverBackfillFinalize(testEnv, payload, now);

    await testEnv.DB.prepare("DELETE FROM event_cover_render_objects WHERE profile_id = 'framed-default'").run();
    const proof = await proveZeroLegacyCovers(testEnv);
    expect(proof.incompleteActiveSets).toBe(1);
    expect(proof.proven).toBe(false);
  });

  it('rejects an active set with no manifest digest or with a cross-event object', async () => {
    const env = backfillEnv();
    await coverBackfillPreflight(env, payload, now);
    await coverBackfillNormalize(env, payload, now);
    await renderEveryProfile(env, payload);
    await coverBackfillFinalize(testEnv, payload, now);
    const set = await row<{ id: string; manifest_sha256: string }>(
      'SELECT id, manifest_sha256 FROM event_cover_render_sets WHERE event_id = ?',
      access.event.id,
    );

    await testEnv.DB.prepare('UPDATE event_cover_render_sets SET manifest_sha256 = NULL WHERE id = ?')
      .bind(set.id).run();
    expect(await proveZeroLegacyCovers(testEnv)).toMatchObject({
      incompleteActiveSets: 1, proven: false,
    });

    await testEnv.DB.prepare('UPDATE event_cover_render_sets SET manifest_sha256 = ? WHERE id = ?')
      .bind(set.manifest_sha256, set.id).run();
    const other = await eventAccess('Cross-event object owner');
    await testEnv.DB.prepare(`
      UPDATE event_cover_render_objects SET event_id = ?
      WHERE id = (SELECT id FROM event_cover_render_objects WHERE render_set_id = ? ORDER BY id LIMIT 1)
    `).bind(other.event.id, set.id).run();
    expect(await proveZeroLegacyCovers(testEnv)).toMatchObject({
      incompleteActiveSets: 1, proven: false,
    });
  });

  it('requires an uploaded event to point at its active set master and normalized key', async () => {
    const env = backfillEnv();
    await coverBackfillPreflight(env, payload, now);
    await coverBackfillNormalize(env, payload, now);
    await renderEveryProfile(env, payload);
    await coverBackfillFinalize(testEnv, payload, now);
    const event = await row<{ cover_object_key: string }>(
      'SELECT cover_object_key FROM events WHERE id = ?', access.event.id,
    );

    await testEnv.DB.prepare('UPDATE events SET cover_object_key = NULL WHERE id = ?')
      .bind(access.event.id).run();
    expect(await proveZeroLegacyCovers(testEnv)).toMatchObject({
      uploadsWithoutActiveSet: 1, proven: false,
    });

    await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
      .bind(`${event.cover_object_key}.mismatch`, access.event.id).run();
    expect(await proveZeroLegacyCovers(testEnv)).toMatchObject({
      uploadsWithoutActiveSet: 1, proven: false,
    });
  });

  it('uses the master key the backfilled event now points at', async () => {
    const env = backfillEnv();
    await coverBackfillPreflight(env, payload, now);
    await coverBackfillNormalize(env, payload, now);
    await renderEveryProfile(env, payload);
    await coverBackfillFinalize(testEnv, payload, now);

    const master = await row<{ id: string }>(
      'SELECT id FROM event_cover_masters WHERE event_id = ?', access.event.id,
    );
    expect((await new EventsRepository(testEnv.DB).getById(access.event.id))!.coverObjectKey)
      .toBe(coverMasterKey(access.event.id, master.id));
  });
});

describe('atomic zero-legacy run closure', () => {
  const OLD = '2026-08-01T00:00:00.000Z';
  const DIGEST = 'a'.repeat(64);

  interface ClosureJob {
    id: string;
    eventId: string;
    status: string;
    retryable?: 0 | 1;
    terminalAt?: string | null;
  }

  async function seedClosureRun(input: {
    id: string;
    mode?: 'inventory' | 'execute' | 'verify';
    status?: 'inventorying' | 'executing' | 'verified' | 'failed';
    inventorySha256?: string | null;
    updatedAt?: string;
    jobs?: readonly ClosureJob[];
  }) {
    const mode = input.mode ?? 'verify';
    const status = input.status ?? 'executing';
    const updatedAt = input.updatedAt ?? OLD;
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_backfill_runs (
        id, mode, inventory_sha256, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      mode,
      input.inventorySha256 === undefined
        ? (mode === 'execute' ? DIGEST : null)
        : input.inventorySha256,
      status,
      updatedAt,
      updatedAt,
    ).run();
    for (const [index, job] of (input.jobs ?? []).entries()) {
      await testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_jobs (
          id, run_id, event_id, expected_revision, legacy_key_fingerprint,
          workflow_instance_id, dispatch_state, dispatch_generation, status,
          dependency_versions_json, retryable, terminal_at, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, ?, 'confirmed', 1, ?, '{}', ?, ?, ?, ?)
      `).bind(
        job.id, input.id, job.eventId, DIGEST, `closure-${input.id}-${index}`,
        job.status, job.retryable ?? 0, job.terminalAt ?? null, updatedAt, updatedAt,
      ).run();
    }
  }

  function envBeforeFailedProofWrite(action: () => Promise<void>): AppEnv {
    let acted = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(
      statement,
      {
        get(target, property) {
          if (property === 'bind') {
            return (...values: unknown[]) => wrap(target.bind(...values), sql);
          }
          if (property === 'run') {
            return async <T>() => {
              if (!acted && sql.includes("SET status = 'failed'")) {
                acted = true;
                await action();
              }
              return target.run<T>();
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      },
    );
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { ...testEnv, DB: db };
  }

  function envAfterClosureSelection(action: () => Promise<void>): AppEnv {
    let acted = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(
      statement,
      {
        get(target, property) {
          if (property === 'bind') {
            return (...values: unknown[]) => wrap(target.bind(...values), sql);
          }
          if (property === 'all') {
            return async <T>() => {
              const result = await target.all<T>();
              if (!acted && sql.includes('SELECT r.id FROM event_cover_backfill_runs r')) {
                acted = true;
                await action();
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      },
    );
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { ...testEnv, DB: db };
  }

  beforeEach(resetDatabase);

  it('verifies from the guarded live proof, stamps expiry atomically, and is idempotent', async () => {
    await seedClosureRun({ id: 'verify-green' });

    expect(await recordZeroLegacyVerification(testEnv, 'verify-green', now)).toEqual({
      proof: {
        legacyRows: 0, blockingJobs: 0, incompleteActiveSets: 0,
        uploadsWithoutActiveSet: 0, proven: true,
      },
      transition: 'verified',
    });
    const first = await row<{
      status: string; verified_at: string; updated_at: string; expires_at: string;
    }>(`SELECT status, verified_at, updated_at, expires_at
        FROM event_cover_backfill_runs WHERE id = ?`, 'verify-green');
    expect(first).toEqual({
      status: 'verified', verified_at: now.toISOString(), updated_at: now.toISOString(),
      expires_at: '2026-09-04T12:00:00.000Z',
    });

    expect((await recordZeroLegacyVerification(
      testEnv, 'verify-green', new Date('2026-08-06T12:00:00.000Z'),
    )).transition).toBe('unchanged');
    expect(await row(`SELECT status, verified_at, updated_at, expires_at
      FROM event_cover_backfill_runs WHERE id = ?`, 'verify-green')).toEqual(first);
  });

  it('fails a closable run from a guarded red proof, never a stale diagnostic read', async () => {
    const access = await eventAccess('Atomic red proof');
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
      .bind(legacyKey(access.event.id), access.event.id).run();
    await seedClosureRun({ id: 'verify-red' });

    expect((await recordZeroLegacyVerification(testEnv, 'verify-red', now)).transition).toBe('failed');
    expect(await row(`SELECT status, verified_at, updated_at, expires_at
      FROM event_cover_backfill_runs WHERE id = ?`, 'verify-red')).toEqual({
      status: 'failed', verified_at: null, updated_at: now.toISOString(),
      expires_at: '2026-09-04T12:00:00.000Z',
    });

    await resetDatabase();
    const raced = await eventAccess('Proof turns green');
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
      .bind(legacyKey(raced.event.id), raced.event.id).run();
    await seedClosureRun({ id: 'verify-race' });
    const racingEnv = envBeforeFailedProofWrite(async () => {
      await testEnv.DB.prepare('UPDATE events SET cover_object_key = NULL WHERE id = ?')
        .bind(raced.event.id).run();
    });
    expect(await recordZeroLegacyVerification(racingEnv, 'verify-race', now)).toMatchObject({
      proof: { proven: true }, transition: 'unchanged',
    });
    expect(await row('SELECT status, expires_at FROM event_cover_backfill_runs WHERE id = ?', 'verify-race'))
      .toEqual({ status: 'executing', expires_at: null });
  });

  it('uses the later of closure and the latest job terminal clock for run expiry', async () => {
    const access = await eventAccess('Future terminal clock');
    await seedClosureRun({
      id: 'verify-latest-terminal', mode: 'execute', jobs: [{
        id: 'latest-terminal-job', eventId: access.event.id, status: 'applied',
        terminalAt: '2026-08-05T13:00:00.000Z',
      }],
    });

    expect((await recordZeroLegacyVerification(testEnv, 'verify-latest-terminal', now)).transition)
      .toBe('verified');
    expect(await row('SELECT expires_at FROM event_cover_backfill_runs WHERE id = ?', 'verify-latest-terminal'))
      .toEqual({ expires_at: '2026-09-04T13:00:00.000Z' });
  });

  it('allows a retryable failure at the exact 24-hour boundary', async () => {
    const access = await eventAccess('Restart boundary');
    await seedClosureRun({
      id: 'restart-boundary', mode: 'execute', jobs: [{
        id: 'restart-boundary-job', eventId: access.event.id, status: 'failed', retryable: 1,
        terminalAt: new Date(now.getTime() - BACKFILL_RESTART_WINDOW_MS).toISOString(),
      }],
    });
    await seedClosureRun({
      id: 'inside-restart-boundary', mode: 'execute', jobs: [{
        id: 'inside-restart-boundary-job', eventId: access.event.id,
        status: 'failed', retryable: 1,
        terminalAt: new Date(now.getTime() - BACKFILL_RESTART_WINDOW_MS + 1).toISOString(),
      }],
    });

    expect(await closeCoverBackfillRuns(testEnv, now)).toMatchObject({
      closedVerifiedRuns: 1, closedFailedRuns: 0, expiredRunsStamped: 1,
    });
    expect(await row('SELECT status FROM event_cover_backfill_runs WHERE id = ?', 'restart-boundary'))
      .toEqual({ status: 'verified' });
    expect(await row('SELECT status FROM event_cover_backfill_runs WHERE id = ?', 'inside-restart-boundary'))
      .toEqual({ status: 'executing' });
  });

  it('refuses every incomplete or restartable run shape without stamping expiry', async () => {
    const access = await eventAccess('Closure blockers');
    const key = legacyKey(access.event.id);
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
      .bind(key, access.event.id).run();
    await seedClosureRun({ id: 'inventorying', mode: 'inventory', status: 'inventorying' });
    await seedClosureRun({ id: 'execute-no-inventory', mode: 'execute', inventorySha256: null });
    await seedClosureRun({ id: 'nonterminal', mode: 'execute', jobs: [{
      id: 'nonterminal-job', eventId: access.event.id, status: 'queued',
    }] });
    await seedClosureRun({ id: 'replacement', mode: 'execute', jobs: [{
      id: 'replacement-job', eventId: access.event.id, status: 'needs_replacement',
      terminalAt: '2026-08-05T11:00:00.000Z',
    }] });
    await seedClosureRun({ id: 'retryable', mode: 'execute', jobs: [{
      id: 'retryable-job', eventId: access.event.id, status: 'failed', retryable: 1,
      terminalAt: '2026-08-05T11:00:00.000Z',
    }] });
    await seedClosureRun({ id: 'terminal-without-clock', mode: 'execute', jobs: [{
      id: 'clockless-job', eventId: access.event.id, status: 'applied', terminalAt: null,
    }] });

    expect(await closeCoverBackfillRuns(testEnv, now)).toEqual({
      inspectedJobs: 0, resolvedJobs: 0, closedVerifiedRuns: 0, closedFailedRuns: 0,
      expiredRunsStamped: 0, remainder: false,
    });
    expect((await testEnv.DB.prepare(`
      SELECT id, status, expires_at FROM event_cover_backfill_runs ORDER BY id
    `).all()).results).toEqual([
      { id: 'execute-no-inventory', status: 'executing', expires_at: null },
      { id: 'inventorying', status: 'inventorying', expires_at: null },
      { id: 'nonterminal', status: 'executing', expires_at: null },
      { id: 'replacement', status: 'executing', expires_at: null },
      { id: 'retryable', status: 'executing', expires_at: null },
      { id: 'terminal-without-clock', status: 'executing', expires_at: null },
    ]);
  });

  it('closes only the globally oldest 100 runs and requires a confirming pass', async () => {
    const statements = Array.from({ length: 101 }, (_unused, index) => testEnv.DB.prepare(`
      INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
      VALUES (?, 'verify', 'executing', ?, ?)
    `).bind(
      `bounded-${index.toString().padStart(3, '0')}`,
      OLD,
      OLD,
    ));
    for (let offset = 0; offset < statements.length; offset += 100) {
      await testEnv.DB.batch(statements.slice(offset, offset + 100));
    }

    expect(await closeCoverBackfillRuns(testEnv, now)).toEqual({
      inspectedJobs: 0, resolvedJobs: 0, closedVerifiedRuns: 100, closedFailedRuns: 0,
      expiredRunsStamped: 100, remainder: true,
    });
    expect(await row('SELECT status FROM event_cover_backfill_runs WHERE id = ?', 'bounded-100'))
      .toEqual({ status: 'executing' });
    expect(await closeCoverBackfillRuns(testEnv, now)).toEqual({
      inspectedJobs: 0, resolvedJobs: 0, closedVerifiedRuns: 1, closedFailedRuns: 0,
      expiredRunsStamped: 1, remainder: false,
    });
    expect(await closeCoverBackfillRuns(testEnv, now)).toEqual({
      inspectedJobs: 0, resolvedJobs: 0, closedVerifiedRuns: 0, closedFailedRuns: 0,
      expiredRunsStamped: 0, remainder: false,
    });
  });

  it('filters blockers before the bound so 100 older incomplete runs cannot starve a closer', async () => {
    const access = await eventAccess('Blocked closure queue');
    for (let index = 0; index < 100; index += 1) {
      await seedClosureRun({
        id: `blocked-${index.toString().padStart(3, '0')}`,
        mode: 'execute',
        updatedAt: OLD,
        jobs: [{
          id: `blocked-job-${index.toString().padStart(3, '0')}`,
          eventId: access.event.id,
          status: 'queued',
        }],
      });
    }
    await seedClosureRun({
      id: 'newer-closable', mode: 'verify', updatedAt: '2026-08-02T00:00:00.000Z',
    });

    expect(await closeCoverBackfillRuns(testEnv, now)).toMatchObject({
      closedVerifiedRuns: 1, closedFailedRuns: 0, expiredRunsStamped: 1, remainder: false,
    });
    expect(await row('SELECT status FROM event_cover_backfill_runs WHERE id = ?', 'newer-closable'))
      .toEqual({ status: 'verified' });
    expect(await row<{ count: number }>(`
      SELECT count(*) AS count FROM event_cover_backfill_runs WHERE status = 'executing'
    `)).toEqual({ count: 100 });
  });

  it('reports a conservative remainder when a selected run loses its closure CAS', async () => {
    await seedClosureRun({ id: 'closure-cas', mode: 'verify' });
    const racingEnv = envAfterClosureSelection(async () => {
      await testEnv.DB.prepare(`
        UPDATE event_cover_backfill_runs SET status = 'failed' WHERE id = ?
      `).bind('closure-cas').run();
    });

    expect(await closeCoverBackfillRuns(racingEnv, now)).toEqual({
      inspectedJobs: 0, resolvedJobs: 0, closedVerifiedRuns: 0, closedFailedRuns: 0,
      expiredRunsStamped: 0, remainder: true,
    });
    expect(await row('SELECT status, expires_at FROM event_cover_backfill_runs WHERE id = ?', 'closure-cas'))
      .toEqual({ status: 'failed', expires_at: null });
  });
});

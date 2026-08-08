import { beforeEach, describe, expect, it } from 'vitest';

import { COVER_PIPELINE_VERSIONS, EVENT_COVER_PROFILES } from '../../shared/event-cover';
import { EventsRepository } from '../../worker/db/events';
import {
  confirmCoverBackfillDispatch,
  coverBackfillConfirmStep,
  coverBackfillDependencyVersions,
  coverBackfillFinalize,
  coverBackfillInstanceId,
  coverBackfillNormalize,
  coverBackfillPreflight,
  coverBackfillProfileStep,
  proveZeroLegacyCovers,
  recoverStaleInitialBackfillDispatches,
  resolveSupersededBackfillJobs,
} from '../../worker/workflows/cover-backfill';
import type { CoverBackfillWorkflowAccessor } from '../../worker/workflows/cover-platform';
import { coverKeyFingerprint, coverMasterKey } from '../../worker/storage/event-cover-keys';
import {
  reconcileEventCoverPurge,
  type CoverPurgeWorkflowAccessors,
} from '../../worker/workflows/cleanup';
import { eventAccess, resetDatabase, testEnv, withRecordingImages } from './helpers';
import type { AppEnv } from '../../worker/env';

const now = new Date('2026-08-05T12:00:00.000Z');
const RUN = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';

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
}

/** One legacy row, one run, and one job created against exactly that row. */
async function seedJob(access: Access, options: SeedOptions = {}) {
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
    INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
    VALUES (?, 'execute', 'executing', ?, ?)
  `).bind(RUN, now.toISOString(), now.toISOString()).run();

  const instanceId = await coverBackfillInstanceId(RUN, JOB, access.event.id);
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_backfill_jobs (
      id, run_id, event_id, expected_revision, legacy_key_fingerprint, workflow_instance_id,
      dispatch_state, dispatch_generation, status, dependency_versions_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    JOB, RUN, access.event.id, revision, await coverKeyFingerprint(key), instanceId,
    dispatchState, generation, status,
    JSON.stringify(coverBackfillDependencyVersions()), now.toISOString(), claimedAt,
  ).run();

  await testEnv.DB.prepare(`
    INSERT INTO event_cover_workflow_fences (
      workflow_binding, workflow_instance_id, event_id, dispatch_generation, state,
      created_at, updated_at, expires_at
    ) VALUES ('COVER_BACKFILL_WORKFLOW', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    instanceId, access.event.id, fenceGeneration, fenceState,
    now.toISOString(), claimedAt,
    new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString(),
  ).run();

  return { key, instanceId, payload: { runId: RUN, jobId: JOB, eventId: access.event.id } };
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
    expect(await row('SELECT applied_count, queued_count FROM event_cover_backfill_runs WHERE id = ?', RUN))
      .toEqual({ applied_count: 1, queued_count: 0 });
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

    expect(await resolveSupersededBackfillJobs(testEnv, RUN, now)).toBe(0);
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
    expect(await resolveSupersededBackfillJobs(testEnv, RUN, now)).toBe(1);

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

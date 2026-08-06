import { beforeEach, describe, expect, it } from 'vitest';

import { COVER_PIPELINE_VERSIONS, EVENT_COVER_PROFILES } from '../../shared/event-cover';
import { EventsRepository } from '../../worker/db/events';
import {
  coverBackfillDependencyVersions,
  coverBackfillFinalize,
  coverBackfillInstanceId,
  coverBackfillNormalize,
  coverBackfillPreflight,
  coverBackfillProfileStep,
  proveZeroLegacyCovers,
  resolveSupersededBackfillJobs,
} from '../../worker/workflows/cover-backfill';
import { coverKeyFingerprint, coverMasterKey } from '../../worker/storage/event-cover-keys';
import { eventAccess, resetDatabase, testEnv, withRecordingImages } from './helpers';
import type { AppEnv } from '../../worker/env';

const now = new Date('2026-08-05T12:00:00.000Z');
const RUN = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';

type Access = Awaited<ReturnType<typeof eventAccess>>;

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

/** One legacy row, one run, and one job created against exactly that row. */
async function seedJob(access: Access, options: { revision?: number } = {}) {
  const key = legacyKey(access.event.id);
  const revision = options.revision ?? 0;
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
    ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 0, 'queued', ?, ?, ?)
  `).bind(
    JOB, RUN, access.event.id, revision, await coverKeyFingerprint(key), instanceId,
    JSON.stringify(coverBackfillDependencyVersions()), now.toISOString(), now.toISOString(),
  ).run();

  await testEnv.DB.prepare(`
    INSERT INTO event_cover_workflow_fences (
      workflow_binding, workflow_instance_id, event_id, dispatch_generation, state,
      created_at, updated_at, expires_at
    ) VALUES ('COVER_BACKFILL_WORKFLOW', ?, ?, 0, 'open', ?, ?, ?)
  `).bind(
    instanceId, access.event.id, now.toISOString(), now.toISOString(),
    new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString(),
  ).run();

  return { key, instanceId, payload: { runId: RUN, jobId: JOB, eventId: access.event.id } };
}

async function renderEveryProfile(env: AppEnv, payload: { runId: string; jobId: string; eventId: string }) {
  for (const profile of EVENT_COVER_PROFILES) {
    await coverBackfillProfileStep(env, payload, profile.id, now);
  }
}

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

  it('exits before any Images work when deletion blocked the fence', async () => {
    const { payload, instanceId } = await seedJob(access);
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences SET state = 'deletion-blocked' WHERE workflow_instance_id = ?
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

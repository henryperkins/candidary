import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../worker/app';
import { AuthService } from '../../worker/auth/service';
import { MediaRepository } from '../../worker/db/media';
import { MediaObjectWriteTombstoneRepository } from '../../worker/db/media-write-tombstones';
import { LegacyMediaScanRepository } from '../../worker/db/legacy-media-scan';
import { ExportsRepository } from '../../worker/db/exports';
import {
  COVER_CLEANUP_ROWS_PER_CLASS,
  COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
  MAX_COVER_PURGE_FENCES_PER_PASS,
  MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS,
} from '../../shared/constants';
import { EVENT_COVER_PROFILES } from '../../shared/event-cover';
import {
  cleanupAuthScratch,
  cleanupEventCovers,
  cleanupExpiredExports,
  cleanupExpiredReservations,
  cleanupRsvpScratch,
  cleanupMediaObjectWriteTombstones,
  maintainLegacyMediaObjects,
  observeLegacyMediaScanner,
  scanLegacyMediaNamespace,
  deleteEventData,
  promoteLegacyStoredMedia,
  reconcileEventCoverPurge,
  resumeDeletedEventPurges,
  scheduledCleanup,
  type CoverPurgeWorkflowAccessors,
} from '../../worker/workflows/cleanup';
import { processExport } from '../../worker/workflows/export';
import type { CoverWorkflowLookup } from '../../worker/workflows/cover-platform';
import { restartCoverPublication } from '../../worker/services/event-cover-publication';
import { finalizedMediaObjectKey } from '../../worker/storage/media-keys';
import worker from '../../worker/index';
import {
  EVENT_COVER_TABLES,
  batchD1Statements,
  eventAccess,
  importRoster,
  openRsvp,
  png,
  resetDatabase,
  seedEventCoverGraph,
  testEnv,
  uploadPending,
  writeHeaders,
} from './helpers';

const ROSTER = [
  'household_key,household_label,invitee_name,plus_one_slots',
  'perkins,Perkins household,Henry Perkins,1',
  'rivera,Rivera household,Avery Rivera,0',
].join('\n');

type Access = Awaited<ReturnType<typeof eventAccess>>;

// Opens a real household session so a sweep or a purge is measured against the
// rows the product actually creates rather than hand-written fixtures.
async function householdSession(access: Access, firstName: string) {
  const response = await createApp().request(`/api/event/${access.event.slug}/rsvp/lookup`, {
    method: 'POST',
    headers: writeHeaders(access.guest),
    body: JSON.stringify({ firstName }),
  }, testEnv);
  const body = await response.json<any>();
  if (body.data?.status !== 'matched') {
    throw new Error(`Lookup fixture did not match: ${JSON.stringify(body)}`);
  }
  return body.data.household as { id: string; version: number };
}

async function rsvpReady(openPhotosEarly = true) {
  const access = await eventAccess('Maya & Theo', openPhotosEarly);
  await importRoster(access, ROSTER);
  await openRsvp(access);
  return access;
}

async function foreignKeyCheck() {
  return (await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).results;
}

async function countRows(table: string, eventId: string) {
  const row = await testEnv.DB.prepare(`SELECT count(*) AS count FROM ${table} WHERE event_id = ?`)
    .bind(eventId).first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * A scripted platform for the purge coordinator.
 *
 * `terminate` rewrites its own instance's next lookup to `terminated`, because
 * that is what the real platform does and the coordinator is required to
 * re-verify rather than assume its own call worked.
 */
function purgeAccessors(
  script: Record<string, CoverWorkflowLookup | 'throw'> = {},
  failures: { terminate?: boolean; create?: boolean } = {},
) {
  const calls: string[] = [];
  const scripted = new Map<string, CoverWorkflowLookup | 'throw'>(Object.entries(script));
  const shared = {
    async lookup(id: string): Promise<CoverWorkflowLookup> {
      calls.push(`lookup:${id}`);
      const entry = scripted.get(id);
      if (entry === 'throw') throw new Error('binding unavailable');
      return entry ?? { kind: 'status', status: 'complete' };
    },
    async terminate(id: string) {
      calls.push(`terminate:${id}`);
      if (failures.terminate) throw new Error('terminate refused');
      scripted.set(id, { kind: 'status', status: 'terminated' });
    },
    async resume(id: string) { calls.push(`resume:${id}`); },
    async restart(id: string) { calls.push(`restart:${id}`); },
  };
  const accessors: CoverPurgeWorkflowAccessors = {
    render: {
      ...shared,
      async create(id: string) {
        calls.push(`create:${id}`);
        if (failures.create) throw new Error('create refused');
        scripted.set(id, { kind: 'status', status: 'running' });
      },
    },
    backfill: {
      ...shared,
      async createBatch(input: Array<{ id: string }>) {
        for (const item of input) {
          calls.push(`createBatch:${item.id}`);
          if (failures.create) throw new Error('create refused');
          scripted.set(item.id, { kind: 'status', status: 'running' });
        }
      },
    },
  };
  return { accessors, calls };
}

/**
 * Purges through the production coordinator against a platform that reports
 * every instance already terminal.
 *
 * A seeded cover graph carries an open fence, and the coordinator will not
 * touch R2 until each one is verified terminal. A purge test therefore has to
 * state what the platform reports rather than leaving it to a binding that
 * cannot answer for an instance that was never really created.
 */
async function purgeSettled(eventId: string, now: Date) {
  return reconcileEventCoverPurge(testEnv, eventId, now, purgeAccessors().accessors);
}

afterEach(() => {
  delete globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__;
});

async function moveStoredMediaToLegacyKey(access: Access, idempotencyKey: string) {
  const media = await uploadPending(access, idempotencyKey);
  const canonical = await testEnv.CANONICAL_MEDIA_BUCKET.get(media.objectKey);
  if (!canonical?.body) throw new Error('Expected a finalized media object fixture.');
  const legacyObjectKey = `events/${access.event.id}/media/${media.id}`;
  await testEnv.MEDIA_BUCKET.put(legacyObjectKey, canonical.body, {
    httpMetadata: { contentType: media.mimeType },
  });
  // The fixture starts from a new-code upload only to get valid media bytes.
  // Remove its canonical-finalization fence before rewriting the row into the
  // legacy shape this helper is meant to simulate.
  await testEnv.DB.prepare('DELETE FROM media_object_promotions WHERE media_id = ?')
    .bind(media.id).run();
  // Runtime fixtures need to model rows grandfathered by 0015. The production
  // trigger correctly forbids creating this shape after migration, so this
  // isolated test helper removes it only for the synthetic pre-migration row.
  await testEnv.DB.exec('DROP TRIGGER IF EXISTS media_stored_legacy_guard_update;');
  await testEnv.DB.prepare(`
    UPDATE media SET object_key = ?, object_bucket_generation = 'legacy',
      reservation_expires_at = ? WHERE id = ?
  `).bind(legacyObjectKey, '2026-07-21T11:59:00.000Z', media.id).run();
  await testEnv.CANONICAL_MEDIA_BUCKET.delete(media.objectKey);
  return { ...media, objectKey: legacyObjectKey, objectBucketGeneration: 'legacy' as const };
}

describe('Guestbook export cleanup', () => {
  beforeEach(resetDatabase);

  it('deletes the complete durable inventory before expiring a job and retains immutable snapshot rows', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'cleanup-export', 'Frozen cleanup caption');
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date('2026-08-12T12:00:00.000Z'));
    const repository = new ExportsRepository(testEnv.DB);
    const parts = await repository.listParts(job.id);
    const keys = [
      ready!.manifestObjectKey,
      ...parts.map(({ objectKey }) => objectKey),
      ready!.guestbookHtmlObjectKey,
      ready!.guestbookCsvObjectKey,
    ].filter((key): key is string => Boolean(key));

    expect(await cleanupExpiredExports(testEnv, new Date('2026-08-14T12:00:00.000Z'))).toBe(1);
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
    expect(await repository.getById(job.id)).toMatchObject({ state: 'expired' });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(1);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_media_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(1);
  });

  it('keeps Ready state and durable inventory when object deletion fails', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'cleanup-failure', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await processExport(testEnv, job.id, new Date('2026-08-12T12:00:00.000Z'));
    const bucket = Object.create(testEnv.MEDIA_BUCKET) as R2Bucket;
    bucket.delete = vi.fn(async () => { throw new Error('R2 unavailable'); });
    const failingEnv = { ...testEnv, MEDIA_BUCKET: bucket };

    await expect(cleanupExpiredExports(failingEnv, new Date('2026-08-14T12:00:00.000Z')))
      .rejects.toThrow('R2 unavailable');
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({ state: 'ready' });
  });

  it('deletes exact durable export keys before event purge removes dependent rows', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'purge-export', 'Purge caption');
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    const repository = new ExportsRepository(testEnv.DB);
    const parts = await repository.listParts(job.id);
    const durableKeys = [
      ready!.manifestObjectKey,
      ...parts.map(({ objectKey }) => objectKey),
      ready!.guestbookHtmlObjectKey,
      ready!.guestbookCsvObjectKey,
    ].filter((key): key is string => Boolean(key));
    const deleteCalls: string[][] = [];
    const bucket = {
      delete: async (keys: string | string[]) => {
        deleteCalls.push(Array.isArray(keys) ? keys : [keys]);
        return testEnv.MEDIA_BUCKET.delete(keys);
      },
      list: testEnv.MEDIA_BUCKET.list.bind(testEnv.MEDIA_BUCKET),
    } as R2Bucket;
    const purgeEnv = { ...testEnv, MEDIA_BUCKET: bucket };

    const purgeStartedAt = new Date('2099-08-13T10:00:00.000Z');
    expect(await deleteEventData(purgeEnv, access.event.id, purgeStartedAt))
      .toMatchObject({ phase: 'fences', remainder: true });
    await promoteLegacyStoredMedia(
      purgeEnv,
      new Date('2099-08-13T10:21:00.000Z'),
    );
    expect(await deleteEventData(
      purgeEnv,
      access.event.id,
      new Date('2099-08-13T10:22:00.000Z'),
    )).toMatchObject({ phase: 'complete', remainder: false });

    expect(new Set(deleteCalls[0])).toEqual(new Set(durableKeys));
    expect(await testEnv.DB.prepare('SELECT id FROM export_jobs WHERE id = ?').bind(job.id).first()).toBeNull();
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(0);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_media_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(0);
    for (const key of durableKeys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it('holds the event prefix and relational purge until a running export is terminal', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'purge-running-export', 'Frozen caption');
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    let releaseSource!: () => void;
    const released = new Promise<void>((resolve) => { releaseSource = resolve; });
    let sourceReadStarted!: () => void;
    const sourceRead = new Promise<void>((resolve) => { sourceReadStarted = resolve; });
    let held = false;
    const heldBucket = new Proxy(testEnv.CANONICAL_MEDIA_BUCKET, {
      get(target, property) {
        if (property === 'get') {
          return async (key: string) => {
            if (!held && key === media.objectKey) {
              held = true;
              sourceReadStarted();
              await released;
            }
            return target.get(key);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const running = processExport(
      { ...testEnv, CANONICAL_MEDIA_BUCKET: heldBucket },
      job.id,
      new Date('2026-08-12T12:00:00.000Z'),
      undefined,
      '2026-08-12T12:00:00.000Z',
    );
    await sourceRead;
    const partialKey = `events/${access.event.id}/exports/${job.id}/attempt-1/partial.zip`;
    await testEnv.MEDIA_BUCKET.put(partialKey, 'partial');

    const firstPurge = await deleteEventData(testEnv, access.event.id, new Date('2026-08-12T12:00:30.000Z'));
    const eventWhileRunning = await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?')
      .bind(access.event.id).first<{ deleted_at: string | null }>();
    const jobWhileRunning = await new ExportsRepository(testEnv.DB).getById(job.id);
    const partialWhileRunning = await testEnv.MEDIA_BUCKET.head(partialKey);
    releaseSource();
    const settled = await running;

    expect(firstPurge).toMatchObject({ phase: 'fences', remainder: true });
    expect(eventWhileRunning?.deleted_at).not.toBeNull();
    expect(jobWhileRunning).toMatchObject({ state: 'running' });
    expect(partialWhileRunning).not.toBeNull();
    expect(settled).toMatchObject({ state: 'failed', errorCode: 'EXPORT_EVENT_DELETED' });

    await promoteLegacyStoredMedia(testEnv, new Date('2099-08-13T10:21:00.000Z'));
    const completed = await deleteEventData(
      testEnv,
      access.event.id,
      new Date('2099-08-13T10:22:00.000Z'),
    );
    expect(completed).toMatchObject({ phase: 'complete', remainder: false });
    expect((await testEnv.MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` })).objects).toEqual([]);
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
  });
});

async function fenceRow(instanceId: string) {
  return testEnv.DB.prepare(`
    SELECT state, expires_at, dispatch_generation FROM event_cover_workflow_fences
    WHERE workflow_instance_id = ?
  `).bind(instanceId).first<{ state: string; expires_at: string; dispatch_generation: number }>();
}

describe('event cover purge coordinator', () => {
  beforeEach(resetDatabase);

  const now = new Date('2026-08-04T12:00:00.000Z');
  const LEGACY_UNSAFE_RELEASED_AT = '2026-08-04T12:00:00.000Z';
  const LEGACY_UNSAFE_EXPIRES_AT = '2026-09-04T12:00:00.000Z';
  const PURGE_FENCE_PROTOCOL_V2 = 'terminal-proof-v2:';

  async function seeded() {
    const access = await eventAccess();
    const ids = await seedEventCoverGraph(testEnv.DB, access.event.id);
    await testEnv.MEDIA_BUCKET.put(`events/${access.event.id}/cover/masters/m.webp`, png());
    return { access, ids };
  }

  async function prefixKeys(eventId: string) {
    const listed = await testEnv.MEDIA_BUCKET.list({ prefix: `events/${eventId}/` });
    return listed.objects.map(({ key }) => key);
  }

  async function seedExactUnsafeLegacyRelease(
    eventId: string,
    instanceId: string,
    phase: 'fences' | 'r2' | 'relational',
  ) {
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
        .bind(LEGACY_UNSAFE_RELEASED_AT, eventId),
      testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences
        SET state = 'deletion-blocked', created_at = '2026-06-01T00:00:00.000Z',
            updated_at = ?, expires_at = ?
        WHERE workflow_instance_id = ?
      `).bind(LEGACY_UNSAFE_RELEASED_AT, LEGACY_UNSAFE_EXPIRES_AT, instanceId),
      testEnv.DB.prepare(`
        UPDATE event_cover_purge_progress
        SET phase = ?, workflow_binding = NULL, workflow_instance_id = NULL,
            created_at = ?, updated_at = ?
        WHERE event_id = ?
      `).bind(phase, LEGACY_UNSAFE_RELEASED_AT, LEGACY_UNSAFE_RELEASED_AT, eventId),
    ]);
  }

  it('blocks every open fence and holds it against the expiry sweep', async () => {
    const { access, ids } = await seeded();
    const { accessors } = purgeAccessors({ [ids.workflowInstanceId]: { kind: 'unknown', telemetry: 't' } });

    const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

    expect(summary).toMatchObject({ phase: 'fences', remainder: true });
    const fence = await fenceRow(ids.workflowInstanceId);
    expect(fence?.state).toBe('deletion-blocked');
    // An unresolved fence must not be swept while the purge still needs it.
    expect(fence?.expires_at).toBe(COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT);
  });

  it('marks nonterminal publication and backfill rows EVENT_DELETED', async () => {
    const { access, ids } = await seeded();
    await testEnv.DB.prepare(`UPDATE event_cover_backfill_jobs SET status = 'rendering' WHERE id = ?`)
      .bind(ids.jobId).run();
    const { accessors } = purgeAccessors({ [ids.workflowInstanceId]: { kind: 'unknown', telemetry: 't' } });

    await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

    expect(await testEnv.DB.prepare(`
      SELECT status, failure_code, retryable FROM event_cover_backfill_jobs WHERE id = ?
    `).bind(ids.jobId).first()).toMatchObject({
      status: 'failed', failure_code: 'EVENT_DELETED', retryable: 0,
    });
  });

  it('settles an undispatched generation-zero backfill fence without consulting the platform', async () => {
    const access = await eventAccess();
    const runId = '10000000-0000-4000-8000-000000000001';
    const jobId = '20000000-0000-4000-8000-000000000002';
    const instanceId = 'cb1-000000000000000000000000000000000000000000000001';
    const timestamp = now.toISOString();
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
        VALUES (?, 'execute', 'executing', ?, ?)
      `).bind(runId, timestamp, timestamp),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_jobs (
          id, run_id, event_id, expected_revision, legacy_key_fingerprint,
          workflow_instance_id, dispatch_state, dispatch_generation, status,
          dependency_versions_json, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, ?, 'pending', 0, 'queued', '{}', ?, ?)
      `).bind(jobId, runId, access.event.id, 'a'.repeat(64), instanceId, timestamp, timestamp),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        ) VALUES ('COVER_BACKFILL_WORKFLOW', ?, ?, 0, 'open', ?, ?, ?)
      `).bind(instanceId, access.event.id, timestamp, timestamp, COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT),
    ]);
    const platform = purgeAccessors({ [instanceId]: 'throw' });

    const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, platform.accessors);

    expect(platform.calls).toEqual([]);
    expect(summary).toMatchObject({ phase: 'complete', remainder: false, platformMutations: 0 });
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    expect(await fenceRow(instanceId)).toMatchObject({
      state: 'deletion-blocked', dispatch_generation: 0,
    });
  });

  /**
   * `unknown` never settling is correct, but the hold sentinel also removes the
   * fence from the only sweep that would ever have deleted it — so "never
   * settles" meant exactly that, and an event whose publication `create()` had
   * failed stayed soft-deleted with every object intact for good.
   */
  it('keeps an old unknown fence blocked even when termination also fails', async () => {
    const { access, ids } = await seeded();
    const unclassifiable: Record<string, CoverWorkflowLookup> = {
      [ids.workflowInstanceId]: { kind: 'unknown', telemetry: 't' },
    };

    // While the fence is young the purge waits, and nothing is touched.
    const parked = await reconcileEventCoverPurge(
      testEnv, access.event.id, now, purgeAccessors(unclassifiable).accessors,
    );
    expect(parked).toMatchObject({ phase: 'fences', remainder: true });
    expect((await fenceRow(ids.workflowInstanceId))?.expires_at)
      .toBe(COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT);
    expect(await prefixKeys(access.event.id)).not.toEqual([]);

    // Age never proves terminal state. Even after the old 31-day escape hatch,
    // an unknown lookup and failed termination must keep R2 blocked.
    const later = new Date(now.getTime() + 32 * 24 * 60 * 60 * 1000);
    const { accessors, calls } = purgeAccessors(unclassifiable, { terminate: true });
    const parkedAgain = await reconcileEventCoverPurge(testEnv, access.event.id, later, accessors);

    expect(calls).toEqual([`lookup:${ids.workflowInstanceId}`]);
    expect(parkedAgain).toMatchObject({ phase: 'fences', remainder: true });
    expect((await fenceRow(ids.workflowInstanceId))?.expires_at)
      .toBe(COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT);
    expect(await prefixKeys(access.event.id)).not.toEqual([]);
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).not.toBeNull();
  });

  it.each(['r2', 'relational'] as const)(
    'rolls an invalid legacy fence back from %s and parks before R2',
    async (phase) => {
      const { access, ids } = await seeded();
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_workflow_fences
          SET state = 'deletion-blocked', updated_at = ?, expires_at = ?
          WHERE workflow_instance_id = ?
        `).bind('2026-08-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z', ids.workflowInstanceId),
        testEnv.DB.prepare(`
          UPDATE event_cover_purge_progress SET phase = ? WHERE event_id = ?
        `).bind(phase, access.event.id),
      ]);
      const { accessors, calls } = purgeAccessors({
        [ids.workflowInstanceId]: { kind: 'unknown', telemetry: 'legacy-upgrade' },
      });

      const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

      expect(calls).toEqual([`lookup:${ids.workflowInstanceId}`]);
      expect(summary).toMatchObject({ phase: 'fences', remainder: true, inspected: 1 });
      expect(await prefixKeys(access.event.id)).not.toEqual([]);
      expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
        .bind(access.event.id).first()).not.toBeNull();
      expect(await testEnv.DB.prepare(`
        SELECT phase FROM event_cover_purge_progress WHERE event_id = ?
      `).bind(access.event.id).first()).toEqual({ phase: 'fences' });
      expect(await fenceRow(ids.workflowInstanceId)).toMatchObject({
        expires_at: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
      });
    },
  );

  it('treats a malformed legacy fence timestamp as unresolved rather than fresh zero', async () => {
    const { access, ids } = await seeded();
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET state = 'deletion-blocked', updated_at = 'legacy-invalid', expires_at = ?
      WHERE workflow_instance_id = ?
    `).bind('2026-08-20T00:00:00.000Z', ids.workflowInstanceId).run();
    const { accessors, calls } = purgeAccessors({
      [ids.workflowInstanceId]: { kind: 'unknown', telemetry: 'malformed-upgrade' },
    });

    const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

    expect(calls).toEqual([`lookup:${ids.workflowInstanceId}`]);
    expect(summary).toMatchObject({ phase: 'fences', remainder: true });
    expect(await prefixKeys(access.event.id)).not.toEqual([]);
    expect(await fenceRow(ids.workflowInstanceId)).toMatchObject({
      expires_at: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
    });
  });

  it.each(['fences', 'r2', 'relational'] as const)(
    'upgrades an exact unsafe legacy release in %s before trusting any terminal stamp',
    async (phase) => {
      const { access, ids } = await seeded();
      await seedExactUnsafeLegacyRelease(access.event.id, ids.workflowInstanceId, phase);
      const objectKey = `events/${access.event.id}/cover/exact-unsafe-${phase}.webp`;
      await testEnv.MEDIA_BUCKET.put(objectKey, png());
      const { accessors, calls } = purgeAccessors({
        [ids.workflowInstanceId]: { kind: 'unknown', telemetry: 'legacy-terminate-failed' },
      }, { terminate: true });

      const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

      expect(calls).toEqual([`lookup:${ids.workflowInstanceId}`]);
      expect(summary).toMatchObject({ phase: 'fences', remainder: true, inspected: 1 });
      expect(await testEnv.MEDIA_BUCKET.head(objectKey)).not.toBeNull();
      expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
        .bind(access.event.id).first()).not.toBeNull();
      expect(await testEnv.DB.prepare(`
        SELECT operation_id FROM event_cover_publish_receipts WHERE event_id = ?
      `).bind(access.event.id).first()).not.toBeNull();
      expect(await fenceRow(ids.workflowInstanceId)).toMatchObject({
        state: 'deletion-blocked', expires_at: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
      });
      expect(await testEnv.DB.prepare(`
        SELECT phase, workflow_binding, workflow_instance_id
        FROM event_cover_purge_progress WHERE event_id = ?
      `).bind(access.event.id).first()).toEqual({
        phase: 'fences',
        workflow_binding: PURGE_FENCE_PROTOCOL_V2,
        workflow_instance_id: null,
      });
    },
  );

  it('inspects at most ten fences and spends at most five platform mutations', async () => {
    const access = await eventAccess();
    const timestamp = now.toISOString();
    const ids = Array.from({ length: 11 }, (_, index) => `bounded-${String(index + 1).padStart(2, '0')}`);
    await testEnv.DB.batch(ids.map((id) => testEnv.DB.prepare(`
      INSERT INTO event_cover_workflow_fences (
        workflow_binding, workflow_instance_id, event_id, dispatch_generation,
        state, created_at, updated_at, expires_at
      ) VALUES ('COVER_RENDER_WORKFLOW', ?, ?, 1, 'open', ?, ?, ?)
    `).bind(id, access.event.id, timestamp, timestamp, timestamp)));
    const script = Object.fromEntries(ids.map((id, index) => [
      id,
      { kind: 'status', status: index < 5 ? 'complete' : 'running' } satisfies CoverWorkflowLookup,
    ]));
    const { accessors, calls } = purgeAccessors(script);

    const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

    expect(summary).toMatchObject({
      phase: 'fences', inspected: 10, platformMutations: 5, remainder: true,
    });
    expect(calls.filter((call) => call.startsWith('terminate:'))).toHaveLength(5);
    expect(await testEnv.DB.prepare(`
      SELECT workflow_binding, workflow_instance_id, fences_resolved, platform_mutations
      FROM event_cover_purge_progress WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({
      workflow_binding: 'terminal-proof-v2:COVER_RENDER_WORKFLOW',
      workflow_instance_id: ids[9],
      fences_resolved: 10,
      platform_mutations: 5,
    });
    expect((await fenceRow(ids[10]!))?.expires_at).toBe(COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT);
  });

  async function seedClaimFence(
    eventId: string,
    dispatchState: 'creating' | 'resuming' | 'restarting',
    claimAt: Date,
  ): Promise<{ binding: 'COVER_RENDER_WORKFLOW' | 'COVER_BACKFILL_WORKFLOW'; instanceId: string }> {
    const stamp = claimAt.toISOString();
    const instanceId = `claim-${dispatchState}`;
    if (dispatchState === 'creating') {
      await testEnv.DB.prepare(`
        INSERT INTO event_cover_publish_receipts (
          event_id, operation_id, request_sha256, action, expected_revision, status,
          workflow_instance_id, dependency_versions_json, dispatch_state,
          dispatch_generation, last_dispatch_at, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, 'publish', 0, 'queued', ?, '{}', ?, 1, ?, ?, ?, ?)
      `).bind(
        eventId, `operation-${dispatchState}`, 'a'.repeat(64), instanceId,
        dispatchState, stamp, stamp, stamp, COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
      ).run();
      await testEnv.DB.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        ) VALUES ('COVER_RENDER_WORKFLOW', ?, ?, 1, 'open', ?, ?, ?)
      `).bind(instanceId, eventId, stamp, stamp, COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT).run();
      return { binding: 'COVER_RENDER_WORKFLOW', instanceId };
    }

    const runId = `run-${dispatchState}`;
    const jobId = `job-${dispatchState}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
        VALUES (?, 'execute', 'executing', ?, ?)
      `).bind(runId, stamp, stamp),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_jobs (
          id, run_id, event_id, expected_revision, legacy_key_fingerprint,
          workflow_instance_id, dispatch_state, dispatch_generation, status,
          dependency_versions_json, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, ?, ?, 1, 'queued', '{}', ?, ?)
      `).bind(jobId, runId, eventId, 'b'.repeat(64), instanceId, dispatchState, stamp, stamp),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        ) VALUES ('COVER_BACKFILL_WORKFLOW', ?, ?, 1, 'open', ?, ?, ?)
      `).bind(instanceId, eventId, stamp, stamp, COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT),
    ]);
    return { binding: 'COVER_BACKFILL_WORKFLOW', instanceId };
  }

  it.each(['creating', 'resuming', 'restarting'] as const)(
    'parks a 119-second %s claim without any platform call and preserves its clock',
    async (dispatchState) => {
      const access = await eventAccess();
      const claimAt = new Date(now.getTime() - 119_000);
      const { binding, instanceId } = await seedClaimFence(access.event.id, dispatchState, claimAt);
      const { accessors, calls } = purgeAccessors();

      const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

      expect(summary).toMatchObject({ phase: 'fences', inspected: 0, platformMutations: 0, remainder: true });
      expect(calls).toEqual([]);
      const table = binding === 'COVER_RENDER_WORKFLOW'
        ? 'event_cover_publish_receipts' : 'event_cover_backfill_jobs';
      const clock = binding === 'COVER_RENDER_WORKFLOW' ? 'last_dispatch_at' : 'updated_at';
      expect(await testEnv.DB.prepare(`SELECT dispatch_state, ${clock} AS claim_at FROM ${table} WHERE workflow_instance_id = ?`)
        .bind(instanceId).first()).toEqual({ dispatch_state: dispatchState, claim_at: claimAt.toISOString() });
    },
  );

  it.each(['creating', 'resuming', 'restarting'] as const)(
    'normally resolves a 121-second %s claim',
    async (dispatchState) => {
      const access = await eventAccess();
      const { instanceId } = await seedClaimFence(
        access.event.id, dispatchState, new Date(now.getTime() - 121_000),
      );
      const { accessors, calls } = purgeAccessors();

      await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

      expect(calls).toContain(`lookup:${instanceId}`);
    },
  );

  /**
   * The column is the durable signal an operator reads to answer "is this purge
   * making progress?". Counting rows *read* would have it climb by one a day
   * for a single fence that never resolves — past the number of fences the
   * event ever had — in exactly the stalled case it exists to surface.
   */
  it('counts the fences it resolved, not the ones it read again', async () => {
    const { access, ids } = await seeded();
    const unclassifiable: Record<string, CoverWorkflowLookup> = {
      [ids.workflowInstanceId]: { kind: 'unknown', telemetry: 't' },
    };

    await reconcileEventCoverPurge(testEnv, access.event.id, now, purgeAccessors(unclassifiable).accessors);
    await reconcileEventCoverPurge(testEnv, access.event.id, now, purgeAccessors(unclassifiable).accessors);

    expect(await testEnv.DB.prepare(
      'SELECT fences_resolved FROM event_cover_purge_progress WHERE event_id = ?',
    ).bind(access.event.id).first()).toEqual({ fences_resolved: 0 });

    await purgeSettled(access.event.id, now);
    // Gone with the event, so the count is read from a pass that resolved one.
    expect(await countRows('event_cover_purge_progress', access.event.id)).toBe(0);
  });

  /**
   * A run pages over the whole fleet, so purging one of its events must not
   * redefine what the run's counters mean for all the others.
   */
  it('recomputes a purged run counter over every nonterminal status', async () => {
    const owner = await eventAccess('Ana & Bo');
    const other = await eventAccess('Cy & Dee');
    const stamp = now.toISOString();
    const job = (id: string, eventId: string, status: string) => testEnv.DB.prepare(`
      INSERT INTO event_cover_backfill_jobs (
        id, run_id, event_id, expected_revision, legacy_key_fingerprint,
        workflow_instance_id, dispatch_state, dispatch_generation, status,
        dependency_versions_json, created_at, updated_at
      ) VALUES (?, 'run-shared', ?, 0, ?, ?, 'confirmed', 1, ?, '{"tonalEffect":1}', ?, ?)
    `).bind(id, eventId, 'a'.repeat(64), `instance-${id}`, status, stamp, stamp);

    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
        VALUES ('run-shared', 'execute', 'executing', ?, ?)
      `).bind(stamp, stamp),
      job('job-purged', owner.event.id, 'applied'),
      job('job-elsewhere', other.event.id, 'rendering'),
    ]);

    await purgeSettled(owner.event.id, now);

    // The other event's job is still in flight, and `rendering` is one of the
    // four statuses that means so.
    expect(await testEnv.DB.prepare(
      "SELECT queued_count FROM event_cover_backfill_runs WHERE id = 'run-shared'",
    ).first()).toEqual({ queued_count: 1 });
  });

  it.each([
    [
      'an unknown lookup',
      { kind: 'unknown', telemetry: 'events/private/cover/cr1-secret' } as const,
      'cover_platform_unknown',
    ],
    [
      'an unmapped status',
      { kind: 'status', status: 'events/private/cover/cr1-secret' } as const,
      'cover_platform_unmapped',
    ],
    [
      'a thrown lookup',
      'throw' as const,
      'cover_platform_lookup_failed',
    ],
  ])('never deletes R2 objects for %s and emits only sanitized telemetry', async (
    _label,
    lookup,
    expectedCode,
  ) => {
    const { access, ids } = await seeded();
    const { accessors, calls } = purgeAccessors({
      [ids.workflowInstanceId]: lookup,
    });
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

      expect(summary.remainder).toBe(true);
      expect(await prefixKeys(access.event.id)).not.toEqual([]);
      // Neither absent information nor a future status performs a platform
      // mutation. The only observable output is one bounded operations event.
      expect(calls.filter((call) => !call.startsWith('lookup:'))).toEqual([]);
      expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
        .bind(access.event.id).first()).not.toBeNull();
      expect(reported).toHaveBeenCalledTimes(1);
      const observation = JSON.parse(String(reported.mock.calls[0]![0])) as Record<string, unknown>;
      expect(observation).toEqual({
        event: 'cover_platform_observation',
        source: 'purge',
        code: expectedCode,
      });
      expect(JSON.stringify(observation)).not.toContain('private');
      expect(JSON.stringify(observation)).not.toContain(ids.workflowInstanceId);
    } finally {
      reported.mockRestore();
    }
  });

  it('keeps an already-terminal purge fence irreversibly blocked through relational completion', async () => {
    const { access, ids } = await seeded();
    const { accessors, calls } = purgeAccessors({
      [ids.workflowInstanceId]: { kind: 'status', status: 'errored' },
    });

    const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

    expect(calls).toEqual([`lookup:${ids.workflowInstanceId}`]);
    expect(summary.phase).toBe('complete');
    // Expiry is stamped only after terminal verification, and outlives the
    // platform's own retention.
    const fence = await fenceRow(ids.workflowInstanceId);
    expect(fence?.state).toBe('deletion-blocked');
    expect(fence?.expires_at).toBe('2026-09-04T12:00:00.000Z|cf2');

    const swept = await cleanupEventCovers(
      testEnv, new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000),
    );
    expect(swept.fencesDeleted).toBe(1);
    expect(await fenceRow(ids.workflowInstanceId)).toBeNull();
  });

  it('soft-delete permanently blocks an already retryable-failed publication without releasing its graph', async () => {
    const { access, ids } = await seeded();
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 1, failure_code = 'COVER_RENDER_UNAVAILABLE',
          dispatch_state = 'confirmed', updated_at = ?, expires_at = ?
      WHERE event_id = ? AND operation_id = ?
    `).bind(
      now.toISOString(), '2026-08-05T12:00:00.000Z', access.event.id, ids.operationId,
    ).run();
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_drafts SET state = 'publishing' WHERE id = ?
      `).bind(ids.draftId),
      testEnv.DB.prepare(`
        UPDATE event_cover_render_sets SET state = 'staging' WHERE id = ?
      `).bind(ids.renderSetId),
    ]);
    const { accessors, calls } = purgeAccessors({
      [ids.workflowInstanceId]: { kind: 'unknown', telemetry: 'cover_platform_unknown' },
    });
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const summary = await reconcileEventCoverPurge(
        testEnv, access.event.id, now, accessors,
      );

      expect(summary).toMatchObject({ phase: 'fences', remainder: true });
      expect(calls).toEqual([`lookup:${ids.workflowInstanceId}`]);
      expect(await testEnv.DB.prepare(`
        SELECT status, retryable, failure_code, dispatch_state, dispatch_generation,
          draft_id, render_set_id
        FROM event_cover_publish_receipts
        WHERE event_id = ? AND operation_id = ?
      `).bind(access.event.id, ids.operationId).first()).toEqual({
        status: 'failed', retryable: 0, failure_code: 'EVENT_DELETED',
        dispatch_state: 'blocked', dispatch_generation: 1,
        draft_id: ids.draftId, render_set_id: ids.renderSetId,
      });
      expect(await testEnv.DB.prepare(`
        SELECT state, draft_revision FROM event_cover_drafts WHERE id = ?
      `).bind(ids.draftId).first()).toEqual({ state: 'publishing', draft_revision: 3 });
      expect(await testEnv.DB.prepare(`
        SELECT state, abandoned_at, cleanup_after FROM event_cover_render_sets WHERE id = ?
      `).bind(ids.renderSetId).first()).toEqual({
        state: 'staging', abandoned_at: null, cleanup_after: null,
      });
      expect(await fenceRow(ids.workflowInstanceId)).toEqual({
        state: 'deletion-blocked', expires_at: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
        dispatch_generation: 1,
      });
    } finally {
      reported.mockRestore();
    }
  });

  it('keeps a late restart blocked after relational cleanup removes its receipt', async () => {
    const { access, ids } = await seeded();
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 1, failure_code = 'COVER_RENDER_UNAVAILABLE',
          dispatch_state = 'confirmed', updated_at = ?, expires_at = ?
      WHERE event_id = ? AND operation_id = ?
    `).bind(
      // The public call below uses a fixed logical instant, while its guarded
      // claim deliberately uses D1's real application clock. Keep this race
      // fixture inside both clocks' restart window.
      now.toISOString(), '2099-08-05T12:00:00.000Z', access.event.id, ids.operationId,
    ).run();

    let signalRestartStarted!: () => void;
    let releaseRestart!: () => void;
    const restartStarted = new Promise<void>((resolve) => { signalRestartStarted = resolve; });
    const restartGate = new Promise<void>((resolve) => { releaseRestart = resolve; });
    const lateCalls: string[] = [];
    const restarting = restartCoverPublication(testEnv, {
      eventId: access.event.id,
      operationId: ids.operationId,
      now,
      workflow: {
        async lookup(id) {
          lateCalls.push(`lookup:${id}`);
          return { kind: 'status', status: 'errored' };
        },
        async create(id) { lateCalls.push(`create:${id}`); },
        async resume(id) { lateCalls.push(`resume:${id}`); },
        async restart(id) {
          lateCalls.push(`restart:${id}`);
          signalRestartStarted();
          await restartGate;
        },
        async terminate(id) { lateCalls.push(`terminate:${id}`); },
      },
    });
    await restartStarted;

    // Claims now use D1's application clock. Align the durable receipt clock
    // with this test's fixed logical instant before advancing it by 121 seconds;
    // otherwise the real wall clock would correctly keep the claim young.
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET last_dispatch_at = ?, updated_at = ?
      WHERE event_id = ? AND operation_id = ?
    `).bind(now.toISOString(), now.toISOString(), access.event.id, ids.operationId).run();

    const purgeAt = new Date(now.getTime() + 121_000);
    const purged = await reconcileEventCoverPurge(
      testEnv,
      access.event.id,
      purgeAt,
      purgeAccessors({
        [ids.workflowInstanceId]: { kind: 'status', status: 'complete' },
      }).accessors,
    );
    expect(purged).toMatchObject({ phase: 'complete', remainder: false });
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    expect(await fenceRow(ids.workflowInstanceId)).toMatchObject({
      state: 'deletion-blocked',
      expires_at: '2026-09-04T12:02:01.000Z|cf2',
    });

    releaseRestart();
    await expect(restarting).resolves.toMatchObject({
      status: 'ineligible', view: null, retryAfterSeconds: null,
    });
    expect(lateCalls).toEqual([
      `lookup:${ids.workflowInstanceId}`,
      `restart:${ids.workflowInstanceId}`,
      `terminate:${ids.workflowInstanceId}`,
    ]);
  });

  it('terminates a live instance and settles it only after re-verifying', async () => {
    const { access, ids } = await seeded();
    const { accessors, calls } = purgeAccessors({
      [ids.workflowInstanceId]: { kind: 'status', status: 'running' },
    });

    const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

    expect(calls).toEqual([
      `lookup:${ids.workflowInstanceId}`,
      `terminate:${ids.workflowInstanceId}`,
      `lookup:${ids.workflowInstanceId}`,
    ]);
    expect(summary.platformMutations).toBe(1);
    expect(summary.phase).toBe('complete');
  });

  it('leaves the fence unresolved and retries when terminate fails', async () => {
    const { access, ids } = await seeded();
    const first = purgeAccessors({ [ids.workflowInstanceId]: { kind: 'status', status: 'running' } }, { terminate: true });

    const blocked = await reconcileEventCoverPurge(testEnv, access.event.id, now, first.accessors);
    expect(blocked).toMatchObject({ phase: 'fences', remainder: true });
    expect(await prefixKeys(access.event.id)).not.toEqual([]);

    const second = purgeAccessors({ [ids.workflowInstanceId]: { kind: 'status', status: 'terminated' } });
    const done = await reconcileEventCoverPurge(testEnv, access.event.id, now, second.accessors);
    expect(done.phase).toBe('complete');
    expect(await prefixKeys(access.event.id)).toEqual([]);
  });

  it('materializes a certified-missing instance under the same ID, then terminates it', async () => {
    const { access, ids } = await seeded();
    const { accessors, calls } = purgeAccessors({ [ids.workflowInstanceId]: { kind: 'missing' } });

    const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

    // Recreated under the *same* fenced ID, never a fresh one, and from the
    // receipt's own immutable payload — then driven terminal so the fence is
    // released against an observed state rather than an assumed one.
    expect(calls).toContain(`create:${ids.workflowInstanceId}`);
    expect(calls).toContain(`terminate:${ids.workflowInstanceId}`);
    expect(calls).not.toContain(`create:${ids.operationId}`);
    expect(summary.phase).toBe('complete');
  });

  it('leaves a certified-missing instance unresolved when its payload row is gone', async () => {
    const { access, ids } = await seeded();
    await testEnv.DB.prepare('DELETE FROM event_cover_publish_receipts WHERE event_id = ?')
      .bind(access.event.id).run();
    const { accessors, calls } = purgeAccessors({ [ids.workflowInstanceId]: { kind: 'missing' } });

    const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

    // Nothing to recreate from means nothing is recreated, and the purge waits
    // rather than sweeping the prefix on an unverified fence.
    expect(calls).toEqual([`lookup:${ids.workflowInstanceId}`]);
    expect(summary).toMatchObject({ phase: 'fences', remainder: true });
  });

  it('completes the relational purge and removes its own progress row', async () => {
    const { access, ids } = await seeded();
    const { accessors } = purgeAccessors({ [ids.workflowInstanceId]: { kind: 'status', status: 'complete' } });

    const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now, accessors);

    expect(summary).toMatchObject({ phase: 'complete', remainder: false });
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    expect(await countRows('event_cover_purge_progress', access.event.id)).toBe(0);
    expect(await foreignKeyCheck()).toEqual([]);
    expect(await prefixKeys(access.event.id)).toEqual([]);
  });

  it('purges an event that never had a cover fence in one pass', async () => {
    const access = await eventAccess();
    const summary = await reconcileEventCoverPurge(testEnv, access.event.id, now);
    expect(summary).toMatchObject({ phase: 'complete', remainder: false, inspected: 0 });
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
  });
});

describe('lifecycle cleanup', () => {
  beforeEach(resetDatabase);

  it('never authorizes an R2 delete when the selected tombstone row is gone', async () => {
    const repository = new MediaObjectWriteTombstoneRepository(testEnv.DB);

    expect(await repository.beginSuppression(
      'events/missing/media/final/missing',
      '2026-08-13T10:00:00.000Z',
    )).toBe(false);
  });

  it('permanently rechecks late writes and rotates a bounded tombstone page fairly', async () => {
    const repository = new MediaObjectWriteTombstoneRepository(testEnv.DB);
    const keys = [
      'events/deleted-event/uploads/media-a',
      'events/deleted-event/uploads/media-b',
      'events/deleted-event/uploads/media-c',
    ];
    for (const [index, objectKey] of keys.entries()) {
      await repository.ensure({
        objectKey,
        eventId: 'deleted-event',
        mediaId: `deleted-media-${index}`,
        objectKind: 'source',
        recordedAt: '2026-08-13T10:00:00.000Z',
      });
      await testEnv.MEDIA_BUCKET.put(objectKey, png());
    }

    const first = await cleanupMediaObjectWriteTombstones(
      testEnv,
      new Date('2026-08-13T10:01:00.000Z'),
      2,
    );
    expect(first).toMatchObject({ inspected: 2, suppressed: 2, observedAbsent: 2 });
    expect(await testEnv.MEDIA_BUCKET.head(keys[0]!)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(keys[1]!)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(keys[2]!)).not.toBeNull();

    const second = await cleanupMediaObjectWriteTombstones(
      testEnv,
      new Date('2026-08-13T10:01:00.000Z'),
      2,
    );
    expect(second).toMatchObject({ inspected: 1, suppressed: 1, observedAbsent: 1 });
    expect(await testEnv.MEDIA_BUCKET.head(keys[2]!)).toBeNull();
    expect(await repository.count()).toBe(3);

    // Relational rows no longer exist, but an arbitrarily late old PUT remains
    // discoverable and is deleted on the next recurring observation.
    await testEnv.MEDIA_BUCKET.put(keys[0]!, png());
    const late = await cleanupMediaObjectWriteTombstones(
      testEnv,
      new Date('2026-08-13T11:02:00.000Z'),
      3,
    );
    expect(late).toMatchObject({ inspected: 3, observedAbsent: 3 });
    expect(await testEnv.MEDIA_BUCKET.head(keys[0]!)).toBeNull();
    expect(await repository.get(keys[0]!)).toMatchObject({
      suppressionStartedAt: '2026-08-13T10:01:00.000Z',
      lastObservedAt: '2026-08-13T11:02:00.000Z',
      lastObservedPresent: false,
      nextCheckAt: '2026-08-13T12:02:00.000Z',
    });
    await expect(testEnv.DB.prepare(`
      DELETE FROM media_object_write_tombstones WHERE object_key = ?
    `).bind(keys[0]).run()).rejects.toThrow(/tombstones are permanent/u);
  });

  it('waits for the permanent janitor even when the legacy scanner fails immediately', async () => {
    const key = 'events/deleted-event/uploads/held-janitor';
    const repository = new MediaObjectWriteTombstoneRepository(testEnv.DB);
    await repository.ensure({
      objectKey: key,
      eventId: 'deleted-event',
      mediaId: 'held-janitor',
      objectKind: 'source',
      recordedAt: '2026-08-13T10:00:00.000Z',
    });
    await repository.beginSuppression(key, '2026-08-13T10:00:00.000Z');
    await testEnv.MEDIA_BUCKET.put(key, png());

    const list = vi.spyOn(testEnv.MEDIA_BUCKET, 'list')
      .mockRejectedValueOnce(new Error('scanner list unavailable'));
    const originalDelete = testEnv.MEDIA_BUCKET.delete.bind(testEnv.MEDIA_BUCKET);
    let releaseDelete!: () => void;
    const deleteReleased = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { markDeleteStarted = resolve; });
    const remove = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete').mockImplementationOnce(async (keys) => {
      markDeleteStarted();
      await deleteReleased;
      return originalDelete(keys);
    });

    let settled = false;
    const maintenance = maintainLegacyMediaObjects(
      testEnv,
      new Date('2026-08-13T10:01:00.000Z'),
    ).finally(() => { settled = true; });
    await deleteStarted;
    await Promise.resolve();
    const waitedForJanitor = !settled;
    releaseDelete();
    await expect(maintenance).rejects.toThrow('scanner list unavailable');

    expect(waitedForJanitor).toBe(true);
    expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
    list.mockRestore();
    remove.mockRestore();
  });

  it('starts hourly permanent maintenance while legacy promotion is still pending', async () => {
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = 'copy-only';
    const lateKey = 'events/hourly-maintenance/uploads/late-old-worker-write';
    await testEnv.MEDIA_BUCKET.put(lateKey, png());
    let releasePromotion!: () => void;
    const promotionReleased = new Promise<void>((resolve) => { releasePromotion = resolve; });
    const promotion = vi.spyOn(MediaRepository.prototype, 'listPromotionWork')
      .mockImplementationOnce(async () => {
        await promotionReleased;
        return [];
    });
    const pending: Promise<unknown>[] = [];
    const controller = {
      cron: '47 * * * *',
      scheduledTime: Date.parse('2026-08-13T10:00:00.000Z'),
    } as ScheduledController;

    worker.scheduled!(
      controller,
      testEnv,
      {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );

    let maintainedBeforePromotion = true;
    try {
      await vi.waitFor(async () => {
        expect(await new MediaObjectWriteTombstoneRepository(testEnv.DB)
          .get(lateKey, 'legacy')).not.toBeNull();
      }, { timeout: 1_000, interval: 10 });
    } catch {
      maintainedBeforePromotion = false;
    }
    releasePromotion();
    await Promise.allSettled(pending);
    promotion.mockRestore();

    expect(maintainedBeforePromotion).toBe(true);
  });

  it('finishes daily permanent maintenance before propagating promotion failure', async () => {
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = 'copy-only';
    const lateKey = 'events/daily-maintenance/uploads/late-old-worker-write';
    await testEnv.MEDIA_BUCKET.put(lateKey, png());
    const promotion = vi.spyOn(MediaRepository.prototype, 'listPromotionWork')
      .mockRejectedValueOnce(new Error('promotion inventory unavailable'));

    await expect(scheduledCleanup(
      testEnv,
      new Date('2026-08-13T10:00:00.000Z'),
    )).rejects.toThrow('promotion inventory unavailable');

    expect(await new MediaObjectWriteTombstoneRepository(testEnv.DB)
      .get(lateKey, 'legacy')).not.toBeNull();
    promotion.mockRestore();
  });

  it('scans the legacy bucket forever without touching cover/export or unknown shapes', async () => {
    const access = await eventAccess('Legacy scanner owner');
    const eventId = access.event.id;
    const sourceKey = `events/${eventId}/media/orphan-a`;
    const previewKey = `events/${eventId}/previews/orphan-b.webp`;
    const coverKey = `events/${eventId}/cover/masters/keep.webp`;
    const purgedCoverKey = 'events/hard-purged/cover/raw/late-draft';
    const exportKey = `events/${eventId}/exports/job-a/attempt-1/manifest.json`;
    const unknownKey = `events/${eventId}/future-shape/object-a`;
    for (const key of [sourceKey, previewKey, coverKey, purgedCoverKey, exportKey, unknownKey]) {
      await testEnv.MEDIA_BUCKET.put(key, png());
    }

    const first = await scanLegacyMediaNamespace(
      testEnv,
      new Date('2026-08-13T10:00:00.000Z'),
      100,
    );
    expect(first).toMatchObject({
      inspected: 6,
      inventoried: 5,
      preserved: 0,
      quarantined: 1,
      wrapped: true,
      epoch: 1,
    });
    const tombstones = new MediaObjectWriteTombstoneRepository(testEnv.DB);
    expect(await tombstones.get(sourceKey, 'legacy')).toMatchObject({
      eventId,
      mediaId: 'orphan-a',
      objectKind: 'source',
      bucketGeneration: 'legacy',
    });
    expect(await tombstones.get(previewKey, 'legacy')).toMatchObject({
      eventId,
      mediaId: 'orphan-b',
      objectKind: 'preview',
      bucketGeneration: 'legacy',
    });
    expect(await tombstones.get(exportKey, 'legacy')).toMatchObject({
      eventId,
      mediaId: 'job-a',
      objectKind: 'export',
      bucketGeneration: 'legacy',
    });
    expect(await tombstones.get(coverKey, 'legacy')).toMatchObject({
      eventId,
      mediaId: eventId,
      objectKind: 'cover',
    });
    expect(await tombstones.get(purgedCoverKey, 'legacy')).toMatchObject({
      eventId: 'hard-purged',
      mediaId: 'hard-purged',
      objectKind: 'cover',
    });
    expect(await testEnv.DB.prepare(`
      SELECT observation_count FROM legacy_media_scan_quarantine WHERE object_key = ?
    `).bind(unknownKey).first<number>('observation_count')).toBe(1);

    await cleanupMediaObjectWriteTombstones(
      testEnv,
      new Date('2026-08-13T10:01:00.000Z'),
      100,
    );
    expect(await testEnv.MEDIA_BUCKET.head(sourceKey)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(previewKey)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(coverKey)).not.toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(purgedCoverKey)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(exportKey)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(unknownKey)).not.toBeNull();

    // A completed scan is only an epoch boundary. A later old-bucket write is
    // found after the cursor wraps and becomes permanently rediscoverable too.
    const lateKey = `events/${eventId}/uploads/orphan-late`;
    await testEnv.MEDIA_BUCKET.put(lateKey, png());
    const second = await scanLegacyMediaNamespace(
      testEnv,
      new Date('2026-08-13T11:00:00.000Z'),
      100,
    );
    expect(second).toMatchObject({ wrapped: true, epoch: 2 });
    expect(await tombstones.get(lateKey, 'legacy')).toMatchObject({
      mediaId: 'orphan-late',
      objectKind: 'source',
    });
  });

  it('uses the configured five-page hourly scan capacity without advancing past unprocessed keys', async () => {
    const eventId = 'scanner-capacity-event';
    const seed = await testEnv.MEDIA_BUCKET.put(
      `events/${eventId}/uploads/seed`,
      png(),
    );
    const pages = Array.from({ length: 6 }, (_, index) => ({
      object: { ...seed, key: `events/${eventId}/uploads/page-${index + 1}` } as R2Object,
      cursor: index === 5 ? undefined : `cursor-${index + 1}`,
      truncated: index !== 5,
    }));
    const list = vi.spyOn(testEnv.MEDIA_BUCKET, 'list').mockImplementation(async (options) => {
      const cursor = options?.cursor;
      const pageIndex = cursor === undefined
        ? 0
        : Number(cursor.slice('cursor-'.length));
      const page = pages[pageIndex]!;
      return {
        objects: [page.object],
        truncated: page.truncated,
        cursor: page.cursor,
        delimitedPrefixes: [],
      } as R2Objects;
    });

    const summary = await scanLegacyMediaNamespace(
      testEnv,
      new Date('2026-08-13T10:00:00.000Z'),
      1,
    );

    expect(summary).toMatchObject({ inspected: 5, inventoried: 5, wrapped: false, epoch: 0 });
    expect(list).toHaveBeenCalledTimes(5);
    expect((await new LegacyMediaScanRepository(testEnv.DB).getState()).cursor).toBe('cursor-5');
    expect(await new MediaObjectWriteTombstoneRepository(testEnv.DB)
      .get(`events/${eventId}/uploads/page-6`, 'legacy')).toBeNull();
    list.mockRestore();
  });

  it('persists full-epoch growth, error, SLA, and overdue-backlog evidence for the live gate', async () => {
    const scan = new LegacyMediaScanRepository(testEnv.DB);
    const firstAt = '2026-08-13T10:00:00.000Z';
    await scan.advance(null, null, firstAt, 0);
    await scan.advance(null, null, '2026-08-13T11:00:00.000Z', 1_000);
    let observation = await observeLegacyMediaScanner(
      testEnv,
      new Date('2026-08-13T11:01:00.000Z'),
    );
    expect(observation).toMatchObject({
      lastCompletedAt: '2026-08-13T11:00:00.000Z',
      lastCompletedStartedAt: firstAt,
      lastCompletedDiscoveredCount: 1_000,
      lastCompletedErrorCount: 0,
      lastCompletedMaxHourlyGrowth: 1_000,
      lastCompletedWithinSla: true,
      growthWithinCeiling: true,
      completedEpochErrorFree: true,
      suppressedBacklogClear: true,
      readyForCanonicalLive: true,
    });

    await scan.recordError('2026-08-13T11:30:00.000Z');
    await scan.advance(null, null, '2026-08-13T12:00:00.000Z', 2_001);
    observation = await observeLegacyMediaScanner(
      testEnv,
      new Date('2026-08-13T12:01:00.000Z'),
    );
    expect(observation).toMatchObject({
      lastCompletedDiscoveredCount: 1_001,
      lastCompletedErrorCount: 1,
      lastCompletedMaxHourlyGrowth: 1_001,
      growthWithinCeiling: false,
      completedEpochErrorFree: false,
      readyForCanonicalLive: false,
    });
    expect((await observeLegacyMediaScanner(
      testEnv,
      new Date('2026-08-14T12:00:00.001Z'),
    )).lastCompletedWithinSla).toBe(false);
  });

  it('reserves the configured janitor quotas for both suppressed and classification work', async () => {
    const due = '2026-08-13T09:00:00.000Z';
    await testEnv.DB.prepare(`
      WITH RECURSIVE seq(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 450
      )
      INSERT INTO media_object_write_tombstones (
        bucket_generation, object_key, event_id, media_id, object_kind,
        suppression_started_at, next_check_at, created_at, updated_at
      ) SELECT
        'legacy', 'events/deleted/uploads/suppressed-' || n,
        'deleted', 'suppressed-' || n, 'source', ?, ?, ?, ? FROM seq
    `).bind(due, due, due, due).run();
    await testEnv.DB.prepare(`
      WITH RECURSIVE seq(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 150
      )
      INSERT INTO media_object_write_tombstones (
        bucket_generation, object_key, event_id, media_id, object_kind,
        next_check_at, created_at, updated_at
      ) SELECT
        'legacy', 'events/deleted/uploads/classify-' || n,
        'deleted', 'classify-' || n, 'source', ?, ?, ? FROM seq
    `).bind(due, due, due).run();

    const dueRows = await new MediaObjectWriteTombstoneRepository(testEnv.DB)
      .listDue('2026-08-13T10:00:00.000Z', 400, 100);
    expect(dueRows).toHaveLength(500);
    expect(dueRows.filter((row) => row.suppressionStartedAt !== null)).toHaveLength(400);
    expect(dueRows.filter((row) => row.suppressionStartedAt === null)).toHaveLength(100);
  });

  it('never lets stale janitor selection delete a newly live canonical final', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'tombstone-live-final');
    const repository = new MediaObjectWriteTombstoneRepository(testEnv.DB);
    const finalKey = finalizedMediaObjectKey(access.event.id, media.id);
    await testEnv.DB.prepare(`DELETE FROM media_object_promotions WHERE media_id = ?`)
      .bind(media.id).run();
    const selected = await repository.listDue('2099-01-01T00:00:00.000Z', 80, 20);
    expect(selected.map(({ objectKey }) => objectKey)).toContain(finalKey);

    const result = await cleanupMediaObjectWriteTombstones(
      testEnv,
      new Date('2099-01-01T00:00:00.000Z'),
      100,
    );

    expect(result.inspected).toBeGreaterThan(0);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(finalKey)).not.toBeNull();
    expect(await repository.get(finalKey, 'canonical')).toMatchObject({ suppressionStartedAt: null });
  });

  it('makes suppression win permanently when it commits before final-pointer adoption', async () => {
    const access = await eventAccess();
    const repository = new MediaObjectWriteTombstoneRepository(testEnv.DB);
    const mediaRepository = new MediaRepository(testEnv.DB);
    const session = await new AuthService(testEnv).resolve(
      access.guest.cookie.split('=')[1]!.split(';')[0],
    );
    const reservedAt = new Date();
    const media = await mediaRepository.reserve({
      id: crypto.randomUUID(),
      eventId: access.event.id,
      uploaderSessionId: session.session.id,
      objectKey: `events/${access.event.id}/uploads/suppression-wins`,
      originalFilename: 'suppression.png',
      mimeType: 'image/png',
      declaredByteSize: 64,
      guestName: 'Avery',
      caption: null,
      idempotencyKey: 'suppression-wins',
      reservationExpiresAt: new Date(reservedAt.getTime() + 10 * 60 * 1_000).toISOString(),
      createdAt: reservedAt.toISOString(),
    });
    const finalKey = finalizedMediaObjectKey(access.event.id, media.id);
    await mediaRepository.failReservation(media.id);
    await testEnv.DB.prepare(`DELETE FROM media_object_promotions WHERE media_id = ?`)
      .bind(media.id).run();

    expect(await repository.beginSuppression(
      finalKey,
      '2099-01-01T11:00:00.000Z',
      'canonical',
    )).toBe(true);
    await expect(testEnv.DB.prepare(`
      UPDATE media
      SET object_key = ?, upload_state = 'stored', byte_size = 64, width = 1, height = 1
      WHERE id = ?
    `).bind(finalKey, media.id).run()).rejects.toThrow();
    expect(await mediaRepository.getById(media.id)).toMatchObject({ uploadState: 'failed' });
    expect(await repository.get(finalKey, 'canonical')).toMatchObject({
      suppressionStartedAt: '2099-01-01T11:00:00.000Z',
    });
  });

  it('promotes a legacy stored object to its canonical immutable key', async () => {
    const access = await eventAccess();
    const media = await moveStoredMediaToLegacyKey(access, 'legacy-promotion');
    const canonicalObjectKey = finalizedMediaObjectKey(access.event.id, media.id);

    await scheduledCleanup(testEnv, new Date('2026-07-21T12:01:00.000Z'));

    expect((await new MediaRepository(testEnv.DB).getById(media.id))?.objectKey)
      .toBe(canonicalObjectKey);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(canonicalObjectKey)).not.toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).toBeNull();
    expect(await new MediaRepository(testEnv.DB).getPromotion(media.id)).toBeNull();
    expect(await new MediaObjectWriteTombstoneRepository(testEnv.DB).get(media.objectKey))
      .toMatchObject({
        suppressionStartedAt: expect.any(String),
        lastObservedPresent: false,
      });
    expect(await new MediaObjectWriteTombstoneRepository(testEnv.DB).get(canonicalObjectKey, 'canonical'))
      .toMatchObject({
        suppressionStartedAt: null,
        lastObservedAt: null,
      });
  });

  it('copy-only freezes and verifies canonical bytes without changing the legacy pointer', async () => {
    const access = await eventAccess();
    const media = await moveStoredMediaToLegacyKey(access, 'legacy-copy-only');
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = 'copy-only';
    const repository = new MediaRepository(testEnv.DB);
    const canonicalObjectKey = finalizedMediaObjectKey(access.event.id, media.id);

    const copiedAt = new Date('2026-07-21T12:01:00.000Z');
    const summary = await promoteLegacyStoredMedia(testEnv, copiedAt, 25, () => copiedAt);

    expect(summary).toMatchObject({ inspected: 1, verified: 1, promoted: 0 });
    expect(await repository.getById(media.id)).toMatchObject({
      objectKey: media.objectKey,
      objectBucketGeneration: 'legacy',
      previewObjectKey: null,
    });
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(canonicalObjectKey)).not.toBeNull();
    expect(await repository.getPromotion(media.id)).toMatchObject({
      state: 'target_verified',
      finalPointerCommitted: false,
      sourceEtag: expect.any(String),
      sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      sourceWidth: media.width,
      sourceHeight: media.height,
      finalEtag: expect.any(String),
      targetVerifiedAt: copiedAt.toISOString(),
      leaseExpiresAt: null,
    });
    expect(await new MediaObjectWriteTombstoneRepository(testEnv.DB)
      .get(canonicalObjectKey, 'canonical')).toMatchObject({ suppressionStartedAt: null });
  });

  it('copy-only excludes an over-limit active verified backlog but still copies pending and hands off inactive proof', async () => {
    const access = await eventAccess();
    const pending = await moveStoredMediaToLegacyKey(access, 'copy-only-after-verified-backlog');
    const sessionId = (await new AuthService(testEnv)
      .resolve(access.guest.cookie.split('=')[1]!.split(';')[0])).session.id;
    await testEnv.DB.exec(`
      DROP TRIGGER IF EXISTS media_stored_legacy_guard_insert;
      DROP TRIGGER IF EXISTS media_stored_legacy_guard_update;
    `);
    for (let index = 0; index < 26; index += 1) {
      const mediaId = `verified-active-${String(index).padStart(2, '0')}`;
      await testEnv.DB.prepare(`
        INSERT INTO media (
          id, event_id, uploader_session_id, object_key, original_filename,
          mime_type, declared_byte_size, byte_size, width, height, guest_name,
          upload_state, publication_status, idempotency_key,
          reservation_expires_at, created_at, stored_at
        ) VALUES (?, ?, ?, ?, ?, 'image/png', 64, 64, 800, 600, 'Avery',
          'stored', 'unpublished', ?, '2026-07-21T11:59:00.000Z', ?, ?)
      `).bind(
        mediaId,
        access.event.id,
        sessionId,
        `events/${access.event.id}/media/${mediaId}`,
        `${mediaId}.png`,
        mediaId,
        '2026-07-21T10:00:00.000Z',
        '2026-07-21T10:00:00.000Z',
      ).run();
      await testEnv.DB.prepare(`
        UPDATE media_object_promotions
        SET state = 'target_verified', claim_token = ?, lease_expires_at = NULL,
          source_etag = ?, source_mime_type = 'image/png', source_byte_size = 64,
          source_sha256 = ?, source_width = 800, source_height = 600,
          final_etag = ?, target_verified_at = ?, updated_at = ?
        WHERE media_id = ?
      `).bind(
        `verified-owner-${String(index).padStart(2, '0')}-at-least-sixteen`,
        `legacy-etag-${index}`,
        index.toString(16).padStart(64, '0'),
        `canonical-etag-${index}`,
        '2026-07-21T10:01:00.000Z',
        `2026-07-21T10:${String(index).padStart(2, '0')}:00.000Z`,
        mediaId,
      ).run();
    }
    const inactiveId = 'verified-inactive-copy-only';
    await testEnv.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename,
        mime_type, declared_byte_size, byte_size, width, height, guest_name,
        upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at
      ) VALUES (?, ?, ?, ?, 'inactive.png', 'image/png', 64, 64, 800, 600,
        'Avery', 'stored', 'unpublished', ?, '2026-07-21T11:59:00.000Z', ?, ?)
    `).bind(
      inactiveId,
      access.event.id,
      sessionId,
      `events/${access.event.id}/media/${inactiveId}`,
      inactiveId,
      '2026-07-21T10:00:00.000Z',
      '2026-07-21T10:00:00.000Z',
    ).run();
    await testEnv.DB.prepare(`
      UPDATE media_object_promotions
      SET state = 'target_verified', claim_token = ?, lease_expires_at = NULL,
        source_etag = 'inactive-source-etag', source_mime_type = 'image/png',
        source_byte_size = 64, source_sha256 = ?, source_width = 800,
        source_height = 600, final_etag = 'inactive-final-etag',
        target_verified_at = ?, updated_at = ?
      WHERE media_id = ?
    `).bind(
      'verified-inactive-owner-at-least-sixteen',
      'f'.repeat(64),
      '2026-07-21T10:01:00.000Z',
      '2026-07-21T10:01:00.000Z',
      inactiveId,
    ).run();
    await testEnv.DB.prepare(`
      UPDATE media SET upload_state = 'deleted', deleted_at = ? WHERE id = ?
    `).bind('2026-07-21T10:02:00.000Z', inactiveId).run();
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = 'copy-only';

    const now = new Date('2026-07-21T12:01:00.000Z');
    const summary = await promoteLegacyStoredMedia(testEnv, now, 25, () => now);
    const repository = new MediaRepository(testEnv.DB);

    expect(summary).toMatchObject({ inspected: 2, verified: 1, promoted: 0 });
    expect(await repository.getPromotion(pending.id)).toMatchObject({ state: 'target_verified' });
    expect(await repository.getPromotion(inactiveId)).toBeNull();
    expect(await repository.getPromotion('verified-active-00')).toMatchObject({
      state: 'target_verified', finalPointerCommitted: false,
    });
    const tombstones = new MediaObjectWriteTombstoneRepository(testEnv.DB);
    expect(await tombstones.get(
      finalizedMediaObjectKey(access.event.id, inactiveId),
      'canonical',
    )).toMatchObject({ suppressionStartedAt: now.toISOString() });
  });

  it.each(['media', 'event'] as const)(
    'hands a canonical target to permanent suppression when %s deletion wins before proof commit',
    async (winner) => {
      const access = await eventAccess();
      const media = await moveStoredMediaToLegacyKey(access, `copy-proof-${winner}-delete`);
      const repository = new MediaRepository(testEnv.DB);
      const originalMark = MediaRepository.prototype.markPromotionTargetVerified;
      const mark = vi.spyOn(MediaRepository.prototype, 'markPromotionTargetVerified')
        .mockImplementationOnce(async function (this: MediaRepository, ...args) {
          if (winner === 'media') {
            await this.delete(media.id, '2026-07-21T12:00:30.000Z');
          } else {
            await testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
              .bind('2026-07-21T12:00:30.000Z', access.event.id).run();
          }
          return originalMark.call(this, ...args);
        });
      globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = 'copy-only';

      const firstAt = new Date('2026-07-21T12:01:00.000Z');
      const first = await promoteLegacyStoredMedia(testEnv, firstAt, 25, () => firstAt);
      mark.mockRestore();
      expect(first.verified).toBe(0);
      expect(await repository.getPromotion(media.id)).toMatchObject({ state: 'copying' });
      const finalKey = finalizedMediaObjectKey(access.event.id, media.id);
      expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(finalKey)).not.toBeNull();

      const recoveredAt = new Date('2026-07-21T12:22:00.000Z');
      await promoteLegacyStoredMedia(testEnv, recoveredAt, 25, () => recoveredAt);

      expect(await repository.getPromotion(media.id)).toBeNull();
      expect(await repository.getById(media.id)).not.toMatchObject({
        objectBucketGeneration: 'canonical', objectKey: finalKey,
      });
      expect(await new MediaObjectWriteTombstoneRepository(testEnv.DB)
        .get(finalKey, 'canonical')).toMatchObject({
          suppressionStartedAt: recoveredAt.toISOString(),
        });
      // Promotion never performs a read-authorized compensation delete. The
      // forever janitor owns this already-suppressed target on a later pass.
      expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(finalKey)).not.toBeNull();
    },
  );

  it('adopts the immutable verified snapshot after a late legacy replay and a lost pointer-CAS response', async () => {
    const access = await eventAccess();
    const media = await moveStoredMediaToLegacyKey(access, 'verified-snapshot-cutover');
    const repository = new MediaRepository(testEnv.DB);
    const previewKey = `events/${access.event.id}/previews/${media.id}.webp`;
    await testEnv.DB.prepare('UPDATE media SET preview_object_key = ? WHERE id = ?')
      .bind(previewKey, media.id).run();
    await testEnv.MEDIA_BUCKET.put(previewKey, png());
    expect(await repository.legacyStoredCutoverReadiness()).toEqual({
      liveLegacyCount: 1, unverifiedLiveLegacyCount: 1,
    });
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = 'copy-only';
    const copiedAt = new Date('2026-07-21T12:01:00.000Z');
    await promoteLegacyStoredMedia(testEnv, copiedAt, 25, () => copiedAt);
    const proof = await repository.getPromotion(media.id);
    expect(proof).toMatchObject({ state: 'target_verified' });
    expect(await repository.legacyStoredCutoverReadiness()).toEqual({
      liveLegacyCount: 1, unverifiedLiveLegacyCount: 0,
    });
    const finalKey = finalizedMediaObjectKey(access.event.id, media.id);
    const frozen = new Uint8Array(await new Response(
      (await testEnv.CANONICAL_MEDIA_BUCKET.get(finalKey))!.body,
    ).arrayBuffer());
    const replay = png().slice();
    replay[replay.byteLength - 1] = replay[replay.byteLength - 1]! ^ 0xff;
    await testEnv.MEDIA_BUCKET.put(media.objectKey, replay, {
      httpMetadata: { contentType: media.mimeType },
    });

    delete globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__;
    const originalCommit = MediaRepository.prototype.commitPromotionPointer;
    const originalHandoff = MediaRepository.prototype.handoffPromotionToPermanentSuppression;
    const commit = vi.spyOn(MediaRepository.prototype, 'commitPromotionPointer')
      .mockImplementationOnce(async function (this: MediaRepository, ...args) {
        const committed = await originalCommit.call(this, ...args);
        if (committed) throw new Error('D1 committed before response loss');
        return committed;
      });
    const handoff = vi.spyOn(MediaRepository.prototype, 'handoffPromotionToPermanentSuppression')
      .mockImplementationOnce(async function (this: MediaRepository, ...args) {
        // Model an old setter transaction admitted just before the canonical
        // guard became visible. Handoff must clear it in the same D1 batch that
        // starts preview suppression, even though the live CAS already cleared
        // the earlier preview value.
        await testEnv.DB.exec('DROP TRIGGER media_object_write_tombstone_guard_update;');
        await testEnv.DB.prepare('UPDATE media SET preview_object_key = ? WHERE id = ?')
          .bind(previewKey, media.id).run();
        return originalHandoff.call(this, ...args);
      });
    const cutoverAt = new Date('2026-07-21T12:02:00.000Z');
    const summary = await promoteLegacyStoredMedia(testEnv, cutoverAt, 25, () => cutoverAt);
    commit.mockRestore();
    handoff.mockRestore();

    expect(summary.promoted).toBe(1);
    expect(await repository.getById(media.id)).toMatchObject({
      objectBucketGeneration: 'canonical',
      objectKey: finalKey,
      previewObjectKey: null,
    });
    expect(await repository.legacyStoredCutoverReadiness()).toEqual({
      liveLegacyCount: 0, unverifiedLiveLegacyCount: 0,
    });
    expect(new Uint8Array(await new Response(
      (await testEnv.CANONICAL_MEDIA_BUCKET.get(finalKey))!.body,
    ).arrayBuffer())).toEqual(frozen);
    expect(new Uint8Array(await new Response(
      (await testEnv.MEDIA_BUCKET.get(media.objectKey))!.body,
    ).arrayBuffer())).toEqual(replay);
    expect(await new MediaObjectWriteTombstoneRepository(testEnv.DB)
      .get(previewKey, 'legacy')).toMatchObject({ suppressionStartedAt: expect.any(String) });
  });

  it('hands a deleted stored canonical photo to the permanent janitor and preserves live finals', async () => {
    const access = await eventAccess();
    const repository = new MediaRepository(testEnv.DB);
    const deletedMedia = await uploadPending(access, 'canonical-delete-handoff');
    const liveMedia = await uploadPending(access, 'canonical-live-handoff');
    const deletedPreview = `events/${access.event.id}/previews/${deletedMedia.id}.webp`;
    await testEnv.MEDIA_BUCKET.put(deletedPreview, png());
    await repository.delete(deletedMedia.id, '2026-08-13T10:00:00.000Z');

    const cleanupAt = new Date('2099-01-01T00:00:00.000Z');
    await promoteLegacyStoredMedia(testEnv, cleanupAt);
    await cleanupMediaObjectWriteTombstones(testEnv, cleanupAt, 100);

    expect(await repository.getPromotion(deletedMedia.id)).toBeNull();
    expect(await repository.getPromotion(liveMedia.id)).toBeNull();
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(deletedMedia.objectKey)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(deletedPreview)).toBeNull();
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(liveMedia.objectKey)).not.toBeNull();
    const tombstones = new MediaObjectWriteTombstoneRepository(testEnv.DB);
    expect(await tombstones.get(deletedMedia.objectKey, 'canonical')).toMatchObject({
      suppressionStartedAt: expect.any(String), lastObservedPresent: false,
    });
    expect(await tombstones.get(liveMedia.objectKey, 'canonical')).toMatchObject({
      suppressionStartedAt: null, lastObservedAt: null,
    });
  });

  it('adopts an identical pre-existing canonical object before deleting the legacy alias', async () => {
    const access = await eventAccess();
    const media = await moveStoredMediaToLegacyKey(access, 'legacy-promotion-recovery');
    const canonicalObjectKey = finalizedMediaObjectKey(access.event.id, media.id);
    await testEnv.CANONICAL_MEDIA_BUCKET.put(canonicalObjectKey, png(), {
      httpMetadata: { contentType: 'image/png' },
    });

    await scheduledCleanup(testEnv, new Date('2026-07-21T12:01:00.000Z'));

    expect((await new MediaRepository(testEnv.DB).getById(media.id))?.objectKey)
      .toBe(canonicalObjectKey);
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).toBeNull();
    expect(await new Response((await testEnv.CANONICAL_MEDIA_BUCKET.get(canonicalObjectKey))!.body).arrayBuffer())
      .toEqual(png().buffer);
  });

  it('recovers the durable pre-crash source digest before a replay can replace the legacy alias', async () => {
    const access = await eventAccess();
    const media = await moveStoredMediaToLegacyKey(access, 'legacy-crash-source-replay');
    const repository = new MediaRepository(testEnv.DB);
    const claim = await repository.claimPromotion(
      media.id,
      'original-promotion-owner-at-least-sixteen',
      '2026-07-21T12:00:00.000Z',
      '2026-07-21T12:20:00.000Z',
    );
    expect(claim).not.toBeNull();
    const source = await testEnv.MEDIA_BUCKET.get(media.objectKey);
    expect(source?.body).toBeTruthy();
    const sourceBytes = await new Response(source!.body).arrayBuffer();
    const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', sourceBytes));
    const digest = [...digestBytes]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    expect(await repository.recordPromotionSource(
      media.id,
      claim!.promotion.claimToken!,
      {
        etag: source!.etag,
        mimeType: 'image/png',
        byteSize: sourceBytes.byteLength,
        sha256: digest,
        width: media.width!,
        height: media.height!,
        recordedAt: '2026-07-21T12:01:00.000Z',
      },
    )).toBe(true);
    const finalKey = finalizedMediaObjectKey(access.event.id, media.id);
    await testEnv.CANONICAL_MEDIA_BUCKET.put(finalKey, sourceBytes, {
      httpMetadata: { contentType: 'image/png' },
      sha256: digestBytes,
    });
    const replay = new Uint8Array(sourceBytes.slice(0));
    replay[replay.byteLength - 1] = replay[replay.byteLength - 1]! ^ 0xff;
    await testEnv.MEDIA_BUCKET.put(media.objectKey, replay, {
      httpMetadata: { contentType: 'image/png' },
    });

    const recoveredAt = new Date('2026-07-21T12:21:00.000Z');
    const summary = await promoteLegacyStoredMedia(testEnv, recoveredAt, 25, () => recoveredAt);
    expect(summary.promoted).toBe(1);
    expect(await repository.getById(media.id)).toMatchObject({
      objectBucketGeneration: 'canonical',
      objectKey: finalKey,
    });
    expect(new Uint8Array(await new Response(
      (await testEnv.CANONICAL_MEDIA_BUCKET.get(finalKey))!.body,
    ).arrayBuffer())).toEqual(new Uint8Array(sourceBytes));
  });

  it('leaves a legacy row gated when an existing canonical object has different same-size bytes', async () => {
    const access = await eventAccess();
    const media = await moveStoredMediaToLegacyKey(access, 'legacy-promotion-conflict');
    const canonicalObjectKey = finalizedMediaObjectKey(access.event.id, media.id);
    const unrelated = png().slice();
    unrelated[unrelated.byteLength - 1] = unrelated[unrelated.byteLength - 1]! ^ 0xff;
    await testEnv.CANONICAL_MEDIA_BUCKET.put(canonicalObjectKey, unrelated, {
      httpMetadata: { contentType: 'image/png' },
    });

    await scheduledCleanup(testEnv, new Date('2026-07-21T12:01:00.000Z'));

    expect((await new MediaRepository(testEnv.DB).getById(media.id))?.objectKey)
      .toBe(media.objectKey);
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();
    expect(await new Response((await testEnv.CANONICAL_MEDIA_BUCKET.get(canonicalObjectKey))!.body).arrayBuffer())
      .toEqual(unrelated.buffer);
  });

  it('does not copy bytes when the legacy object changes after its ETag is inspected', async () => {
    const access = await eventAccess();
    const media = await moveStoredMediaToLegacyKey(access, 'legacy-promotion-etag-swap');
    const canonicalObjectKey = finalizedMediaObjectKey(access.event.id, media.id);
    const replacement = png().slice();
    replacement[replacement.byteLength - 1] = replacement[replacement.byteLength - 1]! ^ 0xff;
    const originalGet = testEnv.MEDIA_BUCKET.get.bind(testEnv.MEDIA_BUCKET);
    let swapped = false;
    const get = vi.spyOn(testEnv.MEDIA_BUCKET, 'get').mockImplementation((async (...args: any[]) => {
      const [key, options] = args;
      if (!swapped && key === media.objectKey && options?.onlyIf?.etagMatches) {
        swapped = true;
        await testEnv.MEDIA_BUCKET.put(media.objectKey, replacement, {
          httpMetadata: { contentType: 'image/png' },
        });
      }
      return originalGet(...args as [string, any]);
    }) as any);

    await scheduledCleanup(testEnv, new Date('2026-07-21T12:01:00.000Z'));
    get.mockRestore();

    expect(swapped).toBe(true);
    expect((await new MediaRepository(testEnv.DB).getById(media.id))?.objectKey)
      .toBe(media.objectKey);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(canonicalObjectKey)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();
  });

  it.each([
    ['same-size non-image bytes', () => new Uint8Array(png().byteLength)],
    ['a valid image with different dimensions', () => png(320, 240)],
  ])('does not promote %s replayed through a legacy alias', async (_label, replacement) => {
    const access = await eventAccess();
    const media = await moveStoredMediaToLegacyKey(access, `legacy-invalid-${crypto.randomUUID()}`);
    const canonicalObjectKey = finalizedMediaObjectKey(access.event.id, media.id);
    const bytes = replacement();
    expect(bytes.byteLength).toBe(media.byteSize);
    await testEnv.MEDIA_BUCKET.put(media.objectKey, bytes, {
      httpMetadata: { contentType: media.mimeType },
    });

    const now = new Date('2026-07-21T12:01:00.000Z');
    await promoteLegacyStoredMedia(testEnv, now, 25, () => now);

    expect(await new MediaRepository(testEnv.DB).getById(media.id)).toMatchObject({
      objectKey: media.objectKey,
      objectBucketGeneration: 'legacy',
    });
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(canonicalObjectKey)).toBeNull();
    expect(await new MediaRepository(testEnv.DB).getPromotion(media.id)).not.toBeNull();
  });

  it('bounds each promotion page and continues after one candidate throws', async () => {
    const access = await eventAccess();
    const candidates = await Promise.all([
      moveStoredMediaToLegacyKey(access, 'legacy-promotion-bad'),
      moveStoredMediaToLegacyKey(access, 'legacy-promotion-next'),
      moveStoredMediaToLegacyKey(access, 'legacy-promotion-later'),
    ]);
    for (const [index, media] of candidates.entries()) {
      await testEnv.DB.prepare('UPDATE media_object_promotions SET updated_at = ? WHERE media_id = ?')
        .bind(`2026-07-21T10:0${index}:00.000Z`, media.id).run();
    }
    const originalHead = testEnv.MEDIA_BUCKET.head.bind(testEnv.MEDIA_BUCKET);
    const head = vi.spyOn(testEnv.MEDIA_BUCKET, 'head').mockImplementation(async (key: string) => {
      if (key === candidates[0]!.objectKey) throw new Error('legacy R2 read failed');
      return originalHead(key);
    });

    const promotionNow = new Date('2026-07-21T12:01:00.000Z');
    const summary = await promoteLegacyStoredMedia(testEnv, promotionNow, 2, () => promotionNow);
    head.mockRestore();

    expect(summary).toEqual({ inspected: 2, verified: 1, promoted: 1, pending: 2 });
    const repository = new MediaRepository(testEnv.DB);
    expect((await repository.getById(candidates[0]!.id))?.objectKey).toBe(candidates[0]!.objectKey);
    expect((await repository.getById(candidates[1]!.id))?.objectKey)
      .toBe(finalizedMediaObjectKey(access.event.id, candidates[1]!.id));
    expect((await repository.getById(candidates[2]!.id))?.objectKey).toBe(candidates[2]!.objectKey);
  });

  it('rotates a full page of absent ambiguous ingress writers so later promotion work cannot starve', async () => {
    const access = await eventAccess();
    const repository = new MediaRepository(testEnv.DB);
    const sessionId = (await new AuthService(testEnv)
      .resolve(access.guest.cookie.split('=')[1]!.split(';')[0])).session.id;
    const expiredLease = '2026-08-13T09:00:00.000Z';
    for (let index = 0; index < 25; index += 1) {
      const mediaId = `ambiguous-backlog-${String(index).padStart(2, '0')}`;
      await repository.reserve({
        id: mediaId,
        eventId: access.event.id,
        uploaderSessionId: sessionId,
        objectKey: `events/${access.event.id}/uploads/${mediaId}`,
        originalFilename: `${mediaId}.png`,
        mimeType: 'image/png',
        declaredByteSize: png().byteLength,
        guestName: 'Avery', caption: null, idempotencyKey: mediaId,
        reservationExpiresAt: '2099-01-01T00:00:00.000Z',
        createdAt: new Date().toISOString(),
      });
      // This is a scheduler-page fixture, not a quota test. Keep the event's
      // capacity counters below the product cap while preserving all 25 rows.
      await testEnv.DB.prepare(`
        UPDATE events SET reserved_media_count = 0, reserved_bytes = 0 WHERE id = ?
      `).bind(access.event.id).run();
      const digest = String(index).padStart(64, '0');
      await testEnv.DB.prepare(`
        UPDATE media_object_promotions
        SET state = 'copying', claim_token = ?, lease_expires_at = ?,
          source_writable_until = ?, source_etag = ?, source_mime_type = 'image/png',
          source_byte_size = ?, source_sha256 = ?, source_width = 800,
          source_height = 600, updated_at = ?
        WHERE media_id = ?
      `).bind(
        `ambiguous-owner-${index}-at-least-sixteen`,
        expiredLease,
        expiredLease,
        `buffer:${digest}`,
        png().byteLength,
        digest,
        `2026-08-13T08:${String(index).padStart(2, '0')}:00.000Z`,
        mediaId,
      ).run();
    }
    const later = await moveStoredMediaToLegacyKey(access, 'later-legacy-work');
    await testEnv.DB.prepare(`
      UPDATE media_object_promotions SET updated_at = ? WHERE media_id = ?
    `).bind('2026-08-13T09:30:00.000Z', later.id).run();
    const now = new Date('2026-08-13T10:00:00.000Z');

    const first = await promoteLegacyStoredMedia(testEnv, now, 25, () => now);
    expect(first).toMatchObject({ inspected: 25, promoted: 0 });
    expect((await repository.getById(later.id))?.objectBucketGeneration).toBe('legacy');
    const second = await promoteLegacyStoredMedia(testEnv, now, 25, () => now);
    expect(second.promoted).toBe(1);
    expect(await repository.getById(later.id)).toMatchObject({
      objectBucketGeneration: 'canonical',
      objectKey: finalizedMediaObjectKey(access.event.id, later.id),
    });
    expect((await repository.getPromotion('ambiguous-backlog-00'))?.state).toBe('copying');
  });

  it('adopts an exact-present canonical final from an expired ambiguous ingress fence', async () => {
    const access = await eventAccess();
    const repository = new MediaRepository(testEnv.DB);
    const sessionId = (await new AuthService(testEnv)
      .resolve(access.guest.cookie.split('=')[1]!.split(';')[0])).session.id;
    const bytes = png(800, 600);
    const media = await repository.reserve({
      id: 'ambiguous-present-ingress', eventId: access.event.id,
      uploaderSessionId: sessionId,
      objectKey: `events/${access.event.id}/uploads/ambiguous-present-ingress`,
      originalFilename: 'ambiguous.png', mimeType: 'image/png',
      declaredByteSize: bytes.byteLength, guestName: 'Avery', caption: null,
      idempotencyKey: 'ambiguous-present-ingress',
      reservationExpiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: new Date().toISOString(),
    });
    const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const digest = [...digestBytes]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    const finalKey = finalizedMediaObjectKey(access.event.id, media.id);
    await testEnv.DB.prepare(`
      UPDATE media_object_promotions
      SET state = 'copying', claim_token = ?, lease_expires_at = ?,
        source_writable_until = ?, source_etag = ?, source_mime_type = 'image/png',
        source_byte_size = ?, source_sha256 = ?, source_width = 800,
        source_height = 600, updated_at = ?
      WHERE media_id = ?
    `).bind(
      'ambiguous-present-owner-at-least-sixteen',
      '2026-08-13T09:00:00.000Z',
      '2026-08-13T09:00:00.000Z',
      `buffer:${digest}`,
      bytes.byteLength,
      digest,
      '2026-08-13T09:00:00.000Z',
      media.id,
    ).run();
    await testEnv.CANONICAL_MEDIA_BUCKET.put(finalKey, bytes, {
      httpMetadata: { contentType: 'image/png' },
      sha256: digestBytes,
    });

    const summary = await promoteLegacyStoredMedia(
      testEnv,
      new Date('2026-08-13T10:00:00.000Z'),
    );
    expect(summary.promoted).toBe(1);
    expect(await repository.getById(media.id)).toMatchObject({
      uploadState: 'stored',
      objectBucketGeneration: 'canonical',
      objectKey: finalKey,
      width: 800,
      height: 600,
    });
    expect(await repository.getPromotion(media.id)).toMatchObject({
      state: 'cleanup_pending',
      finalPointerCommitted: true,
    });
  });

  it('copy-only rotates an exact-present ingress fence without mutating its reserved pointer', async () => {
    const access = await eventAccess();
    const repository = new MediaRepository(testEnv.DB);
    const sessionId = (await new AuthService(testEnv)
      .resolve(access.guest.cookie.split('=')[1]!.split(';')[0])).session.id;
    const bytes = png(800, 600);
    const media = await repository.reserve({
      id: 'copy-only-present-ingress', eventId: access.event.id,
      uploaderSessionId: sessionId,
      objectKey: `events/${access.event.id}/uploads/copy-only-present-ingress`,
      originalFilename: 'copy-only.png', mimeType: 'image/png',
      declaredByteSize: bytes.byteLength, guestName: 'Avery', caption: null,
      idempotencyKey: 'copy-only-present-ingress',
      reservationExpiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: new Date().toISOString(),
    });
    const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const digest = [...digestBytes]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    const finalKey = finalizedMediaObjectKey(access.event.id, media.id);
    await testEnv.DB.prepare(`
      UPDATE media_object_promotions
      SET state = 'copying', claim_token = ?, lease_expires_at = ?,
        source_writable_until = ?, source_etag = ?, source_mime_type = 'image/png',
        source_byte_size = ?, source_sha256 = ?, source_width = 800,
        source_height = 600, updated_at = ?
      WHERE media_id = ?
    `).bind(
      'copy-only-present-owner-at-least-sixteen',
      '2026-08-13T09:00:00.000Z',
      '2026-08-13T09:00:00.000Z',
      `buffer:${digest}`,
      bytes.byteLength,
      digest,
      '2026-08-13T09:00:00.000Z',
      media.id,
    ).run();
    await testEnv.CANONICAL_MEDIA_BUCKET.put(finalKey, bytes, {
      httpMetadata: { contentType: 'image/png' }, sha256: digestBytes,
    });
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = 'copy-only';

    const summary = await promoteLegacyStoredMedia(
      testEnv,
      new Date('2026-08-13T10:00:00.000Z'),
    );

    expect(summary.promoted).toBe(0);
    expect(await repository.getById(media.id)).toMatchObject({
      uploadState: 'reserved', objectBucketGeneration: 'legacy', objectKey: media.objectKey,
    });
    expect(await repository.getPromotion(media.id)).toMatchObject({
      state: 'copying', finalPointerCommitted: false, sourceSha256: digest,
      updatedAt: '2026-08-13T10:00:00.000Z',
    });
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(finalKey)).not.toBeNull();
  });

  it('hands an inactive ambiguous ingress fence to permanent suppression without a finite retirement guess', async () => {
    const access = await eventAccess();
    const repository = new MediaRepository(testEnv.DB);
    const sessionId = (await new AuthService(testEnv)
      .resolve(access.guest.cookie.split('=')[1]!.split(';')[0])).session.id;
    const media = await repository.reserve({
      id: 'ambiguous-inactive-ingress', eventId: access.event.id,
      uploaderSessionId: sessionId,
      objectKey: `events/${access.event.id}/uploads/ambiguous-inactive-ingress`,
      originalFilename: 'ambiguous.png', mimeType: 'image/png',
      declaredByteSize: png().byteLength, guestName: 'Avery', caption: null,
      idempotencyKey: 'ambiguous-inactive-ingress',
      reservationExpiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: new Date().toISOString(),
    });
    const digest = 'c'.repeat(64);
    const finalKey = finalizedMediaObjectKey(access.event.id, media.id);
    await testEnv.DB.prepare(`
      UPDATE media_object_promotions
      SET state = 'copying', claim_token = ?, lease_expires_at = ?,
        source_writable_until = ?, source_etag = ?, source_mime_type = 'image/png',
        source_byte_size = ?, source_sha256 = ?, source_width = 800,
        source_height = 600, updated_at = ?
      WHERE media_id = ?
    `).bind(
      'ambiguous-inactive-owner-at-least-sixteen',
      '2026-08-13T09:00:00.000Z',
      '2026-08-13T09:00:00.000Z',
      `buffer:${digest}`,
      png().byteLength,
      digest,
      '2026-08-13T09:00:00.000Z',
      media.id,
    ).run();
    await repository.delete(media.id, '2026-08-13T09:30:00.000Z');

    await promoteLegacyStoredMedia(testEnv, new Date('2026-08-13T10:00:00.000Z'));

    expect(await repository.getPromotion(media.id)).toBeNull();
    const tombstones = new MediaObjectWriteTombstoneRepository(testEnv.DB);
    expect(await tombstones.get(media.objectKey, 'legacy'))
      .toMatchObject({ suppressionStartedAt: expect.any(String) });
    expect(await tombstones.get(finalKey, 'canonical'))
      .toMatchObject({ suppressionStartedAt: expect.any(String) });
    expect(await repository.getById(media.id)).toMatchObject({ uploadState: 'deleted' });
  });

  it('fails expired reservations D1-first and leaves exact object cleanup to durable inventory', async () => {
    const access = await eventAccess();
    // The whole sweep is dated in the past, so photo delivery has to have been
    // open before the reservation this releases was ever taken.
    await testEnv.DB.prepare('UPDATE events SET photos_open_from = ? WHERE id = ?')
      .bind('2026-07-21T11:00:00.000Z', access.event.id).run();
    const repository = new MediaRepository(testEnv.DB);
    const media = await repository.reserve({
      id: crypto.randomUUID(), eventId: access.event.id, uploaderSessionId: (await new AuthService(testEnv).resolve(access.guest.cookie.split('=')[1]!.split(';')[0])).session.id,
      objectKey: `events/${access.event.id}/media/stale`, originalFilename: 'stale.png', mimeType: 'image/png',
      declaredByteSize: 64, guestName: 'Avery', caption: null, idempotencyKey: 'stale',
      reservationExpiresAt: '2026-07-21T12:00:00.000Z', createdAt: '2026-07-21T11:45:00.000Z',
    });
    await testEnv.MEDIA_BUCKET.put(media.objectKey, png());
    expect(await cleanupExpiredReservations(testEnv, new Date('2026-07-21T12:01:00.000Z'))).toBe(1);
    expect(await repository.getById(media.id)).toMatchObject({ uploadState: 'failed' });
    expect(await repository.getPromotion(media.id)).not.toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();
    const event = await testEnv.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>();
    expect(event.reserved_media_count).toBe(0);
  });

  it('categorically rejects old finalization before D1-first expiry cleanup', async () => {
    const access = await eventAccess();
    await testEnv.DB.prepare('UPDATE events SET photos_open_from = ? WHERE id = ?')
      .bind('2026-07-21T11:00:00.000Z', access.event.id).run();
    const repository = new MediaRepository(testEnv.DB);
    const media = await repository.reserve({
      id: crypto.randomUUID(),
      eventId: access.event.id,
      uploaderSessionId: (await new AuthService(testEnv)
        .resolve(access.guest.cookie.split('=')[1]!.split(';')[0])).session.id,
      objectKey: `events/${access.event.id}/uploads/expiry-finalize-race`,
      originalFilename: 'race.png', mimeType: 'image/png', declaredByteSize: 64,
      guestName: 'Avery', caption: null, idempotencyKey: 'expiry-finalize-race',
      reservationExpiresAt: '2026-07-21T12:00:00.000Z',
      createdAt: '2026-07-21T11:45:00.000Z',
    });
    await testEnv.MEDIA_BUCKET.put(media.objectKey, png());
    const originalFail = MediaRepository.prototype.failReservation;
    let legacyFinalizeRejected = false;
    const fail = vi.spyOn(MediaRepository.prototype, 'failReservation')
      .mockImplementationOnce(async function (this: MediaRepository, id) {
        try {
          await this.finalize(
            id,
            { byteSize: 64, width: 800, height: 600 },
            '2026-07-21T12:01:00.000Z',
            { capturedAt: null, timelineAt: '2026-07-21T12:01:00.000Z' },
          );
        } catch (error) {
          legacyFinalizeRejected = /legacy stored media creation is fenced/u.test(String(error));
        }
        return originalFail.call(this, id);
      });

    expect(await cleanupExpiredReservations(
      testEnv,
      new Date('2026-07-21T12:01:01.000Z'),
    )).toBe(1);
    fail.mockRestore();
    expect(legacyFinalizeRejected).toBe(true);
    expect(await repository.getById(media.id)).toMatchObject({ uploadState: 'failed' });
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();
    expect(await testEnv.DB.prepare(`
      SELECT reserved_media_count, stored_media_count FROM events WHERE id = ?
    `).bind(access.event.id).first()).toEqual({ reserved_media_count: 0, stored_media_count: 0 });
  });

  it('leaves expired reservations untouched throughout Candidate A', async () => {
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = false;
    const access = await eventAccess();
    await testEnv.DB.prepare('UPDATE events SET photos_open_from = ? WHERE id = ?')
      .bind('2026-07-21T11:00:00.000Z', access.event.id).run();
    const repository = new MediaRepository(testEnv.DB);
    const media = await repository.reserve({
      id: crypto.randomUUID(),
      eventId: access.event.id,
      uploaderSessionId: (await new AuthService(testEnv)
        .resolve(access.guest.cookie.split('=')[1]!.split(';')[0])).session.id,
      objectKey: `events/${access.event.id}/uploads/candidate-a-expired`,
      originalFilename: 'held.png', mimeType: 'image/png', declaredByteSize: 64,
      guestName: 'Avery', caption: null, idempotencyKey: 'candidate-a-expired',
      reservationExpiresAt: '2026-07-21T12:00:00.000Z',
      createdAt: '2026-07-21T11:45:00.000Z',
    });

    expect(await cleanupExpiredReservations(
      testEnv,
      new Date('2026-07-21T12:01:00.000Z'),
    )).toBe(0);
    expect(await repository.getById(media.id)).toMatchObject({ uploadState: 'reserved' });
    expect(await testEnv.DB.prepare(`
      SELECT reserved_media_count FROM events WHERE id = ?
    `).bind(access.event.id).first<number>('reserved_media_count')).toBe(1);
  });

  it('marks an event inaccessible, clears its prefix, then removes the row', async () => {
    const access = await eventAccess();
    await testEnv.MEDIA_BUCKET.put(`events/${access.event.id}/media/orphan`, png());
    await testEnv.CANONICAL_MEDIA_BUCKET.put(
      `events/${access.event.id}/media/final/canonical-orphan`,
      png(),
    );
    const summary = await deleteEventData(
      testEnv, access.event.id, new Date('2026-07-21T12:00:00.000Z'),
    );
    expect(summary).toMatchObject({
      eventId: access.event.id,
      phase: 'complete',
      remainder: false,
    });
    const rows = await testEnv.MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` });
    expect(rows.objects).toHaveLength(0);
    const canonicalRows = await testEnv.CANONICAL_MEDIA_BUCKET.list({
      prefix: `events/${access.event.id}/`,
    });
    expect(canonicalRows.objects).toHaveLength(0);
    // The row itself is gone, so nothing about the event survives the purge.
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    const tokens = await testEnv.DB.prepare('SELECT count(*) AS count FROM event_access_tokens WHERE event_id = ?').bind(access.event.id).first<any>();
    expect(tokens.count).toBe(0);
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('keeps Candidate A relational purge disabled on the daily cron while permanent scanning continues', async () => {
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = false;
    const access = await eventAccess();
    await deleteEventData(testEnv, access.event.id, new Date('2026-08-13T03:00:00.000Z'));
    const lateKey = 'events/already-hard-purged/uploads/daily-candidate-a-late';
    await testEnv.MEDIA_BUCKET.put(lateKey, png());

    for (const executedAt of [
      new Date('2026-08-13T03:17:00.000Z'),
      new Date('2026-08-13T04:17:00.000Z'),
    ]) {
      const pending: Promise<unknown>[] = [];
      vi.useFakeTimers().setSystemTime(executedAt);
      worker.scheduled!(
        { cron: '17 3 * * *', scheduledTime: executedAt.getTime() } as ScheduledController,
        testEnv,
        {
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
          passThroughOnException() {},
        } as unknown as ExecutionContext,
      );
      await Promise.all(pending);
      vi.useRealTimers();
    }

    expect(await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?')
      .bind(access.event.id).first()).toMatchObject({ deleted_at: expect.any(String) });
    expect(await new MediaObjectWriteTombstoneRepository(testEnv.DB).get(lateKey, 'legacy'))
      .toMatchObject({ suppressionStartedAt: expect.any(String) });
    expect(await testEnv.MEDIA_BUCKET.head(lateKey)).toBeNull();
  });

  it('does not enter relational purge when a canonical object lands before the independent zero proof', async () => {
    const access = await eventAccess();
    const prefix = `events/${access.event.id}/`;
    const lateKey = `${prefix}media/final/late-canonical`;
    const originalList = testEnv.CANONICAL_MEDIA_BUCKET.list.bind(testEnv.CANONICAL_MEDIA_BUCKET);
    let listCalls = 0;
    const list = vi.spyOn(testEnv.CANONICAL_MEDIA_BUCKET, 'list').mockImplementation(async (options) => {
      listCalls += 1;
      if (listCalls === 2) await testEnv.CANONICAL_MEDIA_BUCKET.put(lateKey, png());
      return originalList(options);
    });

    const first = await deleteEventData(
      testEnv,
      access.event.id,
      new Date('2026-07-21T12:00:00.000Z'),
    );
    expect(first).toMatchObject({ phase: 'r2', remainder: true });
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toEqual({ id: access.event.id });
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(lateKey)).not.toBeNull();

    list.mockRestore();
    const second = await deleteEventData(
      testEnv,
      access.event.id,
      new Date('2026-07-21T12:01:00.000Z'),
    );
    expect(second).toMatchObject({ phase: 'complete', remainder: false });
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(lateKey)).toBeNull();
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
  });

  it('purges an event that still holds stored media and a guest note', async () => {
    const access = await rsvpReady();
    await uploadPending(access, 'keeper');
    await createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({
        idempotencyKey: 'event-purge-note', guestName: 'Avery', body: 'A lovely evening.',
      }),
    }, testEnv);
    await householdSession(access, 'Henry Perkins');

    // `media` and `guest_messages` reference event sessions with ON DELETE
    // RESTRICT, so deleting the event without clearing them first would fail.
    expect(await deleteEventData(
      testEnv,
      access.event.id,
      new Date('2099-08-13T10:00:00.000Z'),
    )).toMatchObject({ phase: 'fences', remainder: true });
    await promoteLegacyStoredMedia(testEnv, new Date('2099-08-13T10:21:00.000Z'));
    expect(await deleteEventData(
      testEnv,
      access.event.id,
      new Date('2099-08-13T10:22:00.000Z'),
    )).toMatchObject({ phase: 'complete', remainder: false });

    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    for (const table of ['media', 'guest_messages', 'rsvp_households', 'rsvp_invitees', 'rsvp_sessions', 'event_entry_credentials']) {
      expect(await countRows(table, access.event.id), `${table} rows after purge`).toBe(0);
    }
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('keeps a soft-deleted event for a later pass when object deletion fails', async () => {
    const access = await eventAccess();
    await testEnv.MEDIA_BUCKET.put(`events/${access.event.id}/media/orphan`, png());
    const failing = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete')
      .mockRejectedValueOnce(new Error('R2 unavailable'));

    await expect(deleteEventData(testEnv, access.event.id, new Date('2026-07-21T12:00:00.000Z')))
      .rejects.toThrow();
    failing.mockRestore();

    // Marked deleted and revoked, but still discoverable — never a hard delete
    // that would strand objects nothing can find again.
    const event = await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?')
      .bind(access.event.id).first<any>();
    expect(event.deleted_at).toBeTruthy();
    const tokens = await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_access_tokens WHERE event_id = ? AND revoked_at IS NULL
    `).bind(access.event.id).first<any>();
    expect(tokens.count).toBe(0);

    // The next scheduled pass retries the same row rather than orphaning it.
    await testEnv.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind('2026-07-21T11:00:00.000Z', access.event.id).run();
    const scheduled: Promise<unknown>[] = [];
    worker.scheduled!(
      { cron: '0 0 * * *', scheduledTime: Date.parse('2026-07-21T12:30:00.000Z') } as ScheduledController,
      testEnv,
      { waitUntil: (promise: Promise<unknown>) => scheduled.push(promise), passThroughOnException() {} } as unknown as ExecutionContext,
    );
    await Promise.all(scheduled);

    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    expect((await testEnv.MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` })).objects)
      .toHaveLength(0);
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('sweeps expired and revoked RSVP sessions and stale rate windows in bounded passes', async () => {
    const access = await rsvpReady();
    const live = await householdSession(access, 'Henry Perkins');

    // One live session, plus more scratch than a single 100-row pass can drain.
    const statements = [];
    for (let index = 0; index < 120; index += 1) {
      statements.push(testEnv.DB.prepare(`
        INSERT INTO rsvp_sessions (
          id, secret_digest, csrf_digest, event_id, household_id,
          write_authority_deadline, expires_at, revoked_at, created_at
        ) VALUES (?, 'digest', 'csrf', ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        access.event.id,
        live.id,
        '2026-07-21T12:00:00.000Z',
        index % 2 === 0 ? '2026-07-21T11:00:00.000Z' : '2027-01-01T00:00:00.000Z',
        index % 2 === 0 ? null : '2026-07-21T11:30:00.000Z',
        '2026-07-21T10:00:00.000Z',
      ));
      statements.push(testEnv.DB.prepare(`
        INSERT INTO rsvp_lookup_rate_limits (
          event_id, action, scope_digest, window_started_at, attempts
        ) VALUES (?, 'lookup_ip', ?, ?, 1)
      `).bind(
        access.event.id,
        `digest-${index}`,
        index === 0 ? '2026-07-21T12:00:00.000Z' : '2026-07-21T11:00:00.000Z',
      ));
    }
    await testEnv.DB.batch(statements);

    const swept = await cleanupRsvpScratch(testEnv, new Date('2026-07-21T12:15:00.000Z'));

    expect(swept).toEqual({ sessions: 120, rateLimits: 119 });
    // The live session and the current window are untouched.
    const sessions = await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM rsvp_sessions WHERE event_id = ?
    `).bind(access.event.id).first<any>();
    expect(sessions.count).toBe(1);
    const windows = await testEnv.DB.prepare(`
      SELECT scope_digest, window_started_at FROM rsvp_lookup_rate_limits WHERE event_id = ?
    `).bind(access.event.id).all<any>();
    // The current window survives; every row older than one window is gone. The
    // real lookup above also charged its own current-window rows, which is why
    // this asserts the boundary rather than an exact row count.
    expect(windows.results.some((row: any) => row.scope_digest === 'digest-0')).toBe(true);
    expect(windows.results.every((row: any) => row.window_started_at >= '2026-07-21T12:00:00.000Z'))
      .toBe(true);
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('keeps target-verified proof and both generations until purge hands them to permanent suppression', async () => {
    const access = await eventAccess();
    const media = await moveStoredMediaToLegacyKey(access, 'purge-target-verified');
    const finalKey = finalizedMediaObjectKey(access.event.id, media.id);
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = 'copy-only';
    await promoteLegacyStoredMedia(
      testEnv,
      new Date('2026-08-13T10:00:00.000Z'),
    );
    const repository = new MediaRepository(testEnv.DB);
    expect(await repository.getPromotion(media.id)).toMatchObject({ state: 'target_verified' });

    delete globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__;
    const first = await deleteEventData(
      testEnv,
      access.event.id,
      new Date('2099-08-13T10:00:00.000Z'),
    );
    expect(first).toMatchObject({ phase: 'fences', remainder: true });
    expect(await repository.getPromotion(media.id)).toMatchObject({ state: 'target_verified' });
    expect(await testEnv.DB.prepare('SELECT id FROM media WHERE id = ?')
      .bind(media.id).first()).toEqual({ id: media.id });
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(finalKey)).not.toBeNull();
    expect(await foreignKeyCheck()).toEqual([]);

    const handedOffAt = new Date('2099-08-13T10:21:00.000Z');
    await promoteLegacyStoredMedia(testEnv, handedOffAt);
    expect(await repository.getPromotion(media.id)).toBeNull();
    await cleanupMediaObjectWriteTombstones(testEnv, handedOffAt, 100);

    const complete = await deleteEventData(
      testEnv,
      access.event.id,
      new Date('2099-08-13T10:22:00.000Z'),
    );
    expect(complete).toMatchObject({ phase: 'complete', remainder: false });
    expect((await testEnv.MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` })).objects)
      .toHaveLength(0);
    expect((await testEnv.CANONICAL_MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` })).objects)
      .toHaveLength(0);
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('sweeps stale guest-message rate rows in bounded pages but retains purge receipts', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(access.event.id).first<string>('id');
    if (!sessionId) throw new Error('Expected a guest session fixture.');
    await batchD1Statements(testEnv.DB, Array.from({ length: 120 }, (_, index) => testEnv.DB.prepare(`
      INSERT INTO guest_message_rate_events (
        id, event_id, session_scope_digest, ip_scope_digest, window_started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), access.event.id, `session-${index}`, `ip-${index}`,
      index === 0 ? '2026-07-21T12:00:00.000Z' : '2026-07-21T11:59:59.999Z',
      '2026-07-21T12:01:00.000Z',
    )));
    await testEnv.DB.prepare(`
      INSERT INTO guest_message_purge_receipts (
        event_id, guest_session_id, idempotency_key, request_hmac, purged_at
      ) VALUES (?, ?, 'retained-receipt', ?, '2026-07-21T11:00:00.000Z')
    `).bind(access.event.id, sessionId, 'a'.repeat(43)).run();

    await scheduledCleanup(testEnv, new Date('2026-07-21T12:15:00.000Z'));

    expect(await testEnv.DB.prepare(`
      SELECT window_started_at FROM guest_message_rate_events WHERE event_id = ?
    `).bind(access.event.id).all()).toMatchObject({
      results: [{ window_started_at: '2026-07-21T12:00:00.000Z' }],
    });
    expect(await testEnv.DB.prepare(`
      SELECT idempotency_key FROM guest_message_purge_receipts WHERE event_id = ?
    `).bind(access.event.id).all()).toMatchObject({
      results: [{ idempotency_key: 'retained-receipt' }],
    });
  });

  it('revokes but never deletes household data when the printed entry is disabled', async () => {
    const access = await rsvpReady();
    await householdSession(access, 'Henry Perkins');

    const disabled = await createApp().request(
      `/api/manage/events/${access.event.id}/entry/disable`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );
    expect(disabled.status).toBe(200);

    const live = await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM rsvp_sessions WHERE event_id = ? AND revoked_at IS NULL
    `).bind(access.event.id).first<any>();
    expect(live.count).toBe(0);
    expect(await countRows('rsvp_households', access.event.id)).toBe(2);
    expect(await countRows('rsvp_invitees', access.event.id)).toBe(3);
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('keeps an archived household in the roster until the event is purged', async () => {
    const access = await rsvpReady();
    const listed = await createApp().request(
      `/api/manage/events/${access.event.id}/rsvp/households`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    const household = (await listed.json<any>()).data.households
      .find((row: any) => row.householdKey === 'rivera');
    const current = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    const rosterVersion = (await current.json<any>()).data.event.rsvpRosterVersion;

    const archived = await createApp().request(
      `/api/manage/events/${access.event.id}/rsvp/households/${household.id}/archive`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({
          expectedVersion: household.version,
          expectedRosterVersion: rosterVersion,
        }),
      },
      testEnv,
    );
    expect(archived.status).toBe(200);

    expect(await countRows('rsvp_households', access.event.id)).toBe(2);
    const exported = await createApp().request(
      `/api/manage/events/${access.event.id}/rsvp/export.csv`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expect(await exported.text()).toContain('rivera');

    await deleteEventData(testEnv, access.event.id, new Date('2026-07-21T12:00:00.000Z'));
    expect(await countRows('rsvp_households', access.event.id)).toBe(0);
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('deletes bounded expired auth scratch while retaining live boundary rows', async () => {
    const accountId = crypto.randomUUID();
    await testEnv.DB.prepare(`
      INSERT INTO host_accounts (id, email, password_hash, created_at)
      VALUES (?, 'host@example.com', 'hash', '2026-07-21T11:00:00.000Z')
    `).bind(accountId).run();
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO host_registration_challenges (
          id, email, password_hash, browser_secret_digest, code_digest,
          expires_at, consumed_at, created_at, updated_at
        ) VALUES (?, ?, 'hash', 'browser', 'code', ?, ?, ?, ?)
      `).bind(
        'pending-consumed',
        'consumed@example.com',
        '2026-07-21T13:00:00.000Z',
        '2026-07-21T12:01:00.000Z',
        '2026-07-21T12:00:00.000Z',
        '2026-07-21T12:01:00.000Z',
      ),
      testEnv.DB.prepare(`
        INSERT INTO host_registration_challenges (
          id, email, password_hash, browser_secret_digest, code_digest,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, 'hash', 'browser', 'code', ?, ?, ?)
      `).bind(
        'pending-boundary',
        'boundary@example.com',
        '2026-07-21T12:15:00.000Z',
        '2026-07-21T12:00:00.000Z',
        '2026-07-21T12:00:00.000Z',
      ),
      testEnv.DB.prepare(`
        INSERT INTO host_login_challenges (
          id, account_id, purpose, secret_digest, expires_at, created_at
        ) VALUES ('login-expired', ?, 'verify', 'digest', ?, ?)
      `).bind(accountId, '2026-07-21T12:14:59.999Z', '2026-07-21T12:00:00.000Z'),
      testEnv.DB.prepare(`
        INSERT INTO host_login_challenges (
          id, account_id, purpose, secret_digest, expires_at, created_at
        ) VALUES ('login-boundary', ?, 'reset', 'digest', ?, ?)
      `).bind(accountId, '2026-07-21T12:15:00.000Z', '2026-07-21T12:00:00.000Z'),
      testEnv.DB.prepare(`
        INSERT INTO host_auth_rate_limits (
          scope_digest, action, window_started_at, attempts
        ) VALUES ('old', 'login', '2026-07-21T11:59:59.999Z', 1)
      `),
      testEnv.DB.prepare(`
        INSERT INTO host_auth_rate_limits (
          scope_digest, action, window_started_at, attempts
        ) VALUES ('boundary', 'login', '2026-07-21T12:00:00.000Z', 1)
      `),
    ]);

    const result = await cleanupAuthScratch(
      testEnv,
      new Date('2026-07-21T12:15:00.000Z'),
    );

    expect(result).toEqual({ registrations: 1, challenges: 1, rateLimits: 1 });
    expect(await testEnv.DB.prepare(`
      SELECT id FROM host_registration_challenges
    `).all()).toMatchObject({ results: [{ id: 'pending-boundary' }] });
    expect(await testEnv.DB.prepare(`
      SELECT id FROM host_login_challenges
    `).all()).toMatchObject({ results: [{ id: 'login-boundary' }] });
    expect(await testEnv.DB.prepare(`
      SELECT scope_digest FROM host_auth_rate_limits
    `).all()).toMatchObject({ results: [{ scope_digest: 'boundary' }] });
  });

  it('uses wall-clock execution time rather than nominal cron time for cleanup', async () => {
    const access = await eventAccess();
    const scheduledAt = new Date('2026-07-21T12:00:00.000Z');
    const executedAt = new Date('2026-07-21T12:10:00.000Z');
    await testEnv.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind('2026-07-21T12:05:00.000Z', access.event.id).run();
    const scheduled: Promise<unknown>[] = [];
    const clock = vi.useFakeTimers();
    clock.setSystemTime(executedAt);

    worker.scheduled!({ cron: '0 0 * * *', scheduledTime: scheduledAt.getTime() } as ScheduledController,
      testEnv,
      { waitUntil: (promise: Promise<unknown>) => scheduled.push(promise), passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(scheduled);
    clock.useRealTimers();

    // A due event is purged outright by the run, so the proof it used wall-clock
    // time is that the row is gone rather than still waiting for the next pass.
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    expect(await foreignKeyCheck()).toEqual([]);
  });
  // Every cover table's `event_id` is ON DELETE RESTRICT, inverting the fifteen
  // CASCADE relationships this schema had before 0012. Without the explicit
  // child-before-parent order, the first event that ever owned a cover fails its
  // purge with a foreign-key error and the scheduled pass retries it forever.
  describe('event cover inventory', () => {
    // All four cover key shapes, so the claim that the existing
    // `events/{id}/` prefix already covers them is asserted rather than assumed.
    async function seedCoverObjects(eventId: string, setId: string, draftId: string) {
      const keys = [
        `events/${eventId}/cover/raw/${draftId}`,
        `events/${eventId}/cover/masters/master-a.webp`,
        `events/${eventId}/cover/previews/${draftId}/natural-1.webp`,
        `events/${eventId}/cover/rendered/${setId}/wide-expanded-1x.jpeg`,
      ];
      for (const key of keys) await testEnv.MEDIA_BUCKET.put(key, png());
      return keys;
    }

    async function coverPrefixKeys(eventId: string) {
      const listed = await testEnv.MEDIA_BUCKET.list({ prefix: `events/${eventId}/` });
      return listed.objects.map(({ key }) => key).sort();
    }

    it('deletes every cover row before the event and leaves no foreign-key violation', async () => {
      const access = await eventAccess();
      const ids = await seedEventCoverGraph(testEnv.DB, access.event.id);
      const keys = await seedCoverObjects(access.event.id, ids.renderSetId, ids.draftId);
      expect(await coverPrefixKeys(access.event.id)).toEqual([...keys].sort());

      await purgeSettled(access.event.id, new Date('2026-08-04T12:00:00.000Z'));

      expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
        .bind(access.event.id).first()).toBeNull();
      for (const table of EVENT_COVER_TABLES) {
        expect(await countRows(table, access.event.id), `${table} rows after purge`).toBe(0);
      }
      // The run has no event foreign key, so it never blocked this purge. It
      // survives with counters recomputed from what actually remains — zero —
      // because it is not yet expiry-eligible; ledger retention is the scheduled
      // cover sweep's job, not the purge's.
      expect(await testEnv.DB.prepare(`
        SELECT total_count, applied_count FROM event_cover_backfill_runs WHERE id = ?
      `).bind(ids.runId).first()).toEqual({ total_count: 0, applied_count: 0 });
      expect(await foreignKeyCheck()).toEqual([]);
      expect(await coverPrefixKeys(access.event.id)).toEqual([]);
    });

    it('removes an emptied backfill run only once it is also past its own expiry', async () => {
      const access = await eventAccess();
      const ids = await seedEventCoverGraph(testEnv.DB, access.event.id);
      await testEnv.DB.prepare(`
        UPDATE event_cover_backfill_runs
        SET status = 'verified', verified_at = ?, expires_at = ?
        WHERE id = ?
      `).bind(
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', ids.runId,
      ).run();

      await purgeSettled(access.event.id, new Date('2026-08-04T12:00:00.000Z'));

      expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM event_cover_backfill_runs')
        .first<{ count: number }>()).toEqual({ count: 0 });
      expect(await foreignKeyCheck()).toEqual([]);
    });

    // The fence has no event foreign key on purpose: it must outlive the row it
    // protected so a late dispatcher cannot do cover work for a purged event.
    it('leaves workflow fences until their terminal expiry, then lets the bounded sweep remove them', async () => {
      const access = await eventAccess();
      const ids = await seedEventCoverGraph(testEnv.DB, access.event.id);
      const now = new Date('2026-08-04T12:00:00.000Z');
      await purgeSettled(access.event.id, now);
      expect(await countRows('event_cover_workflow_fences', access.event.id)).toBe(1);
      // Relational completion removes the owner and event without ever
      // reopening the dispatch fence. Only the tagged terminal deadline lets
      // the later bounded sweep collect it.
      const fence = await fenceRow(ids.workflowInstanceId);
      expect(fence?.state).toBe('deletion-blocked');
      expect(fence?.expires_at)
        .toBe('2026-09-04T12:00:00.000Z|cf2');

      const sweep = await cleanupEventCovers(
        testEnv, new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000),
      );
      expect(sweep.fencesDeleted).toBe(1);
      expect(await countRows('event_cover_workflow_fences', access.event.id)).toBe(0);
    });

    it('keeps a backfill run alive while another event still owns a job', async () => {
      const first = await eventAccess('First');
      const second = await eventAccess('Second');
      const shared = await seedEventCoverGraph(testEnv.DB, first.event.id);
      const other = await seedEventCoverGraph(testEnv.DB, second.event.id);
      // Re-home the second event's job onto the first run, so the run is shared.
      await testEnv.DB.prepare('UPDATE event_cover_backfill_jobs SET run_id = ? WHERE id = ?')
        .bind(shared.runId, other.jobId).run();
      await testEnv.DB.prepare('DELETE FROM event_cover_backfill_runs WHERE id = ?')
        .bind(other.runId).run();

      await purgeSettled(first.event.id, new Date('2026-08-04T12:00:00.000Z'));

      const run = await testEnv.DB.prepare(`
        SELECT total_count, applied_count FROM event_cover_backfill_runs WHERE id = ?
      `).bind(shared.runId).first<{ total_count: number; applied_count: number }>();
      // Survives with counters recomputed from the one job that remains, rather
      // than decremented by hand or left claiming work that no longer exists.
      expect(run).toEqual({ total_count: 1, applied_count: 1 });
      expect(await foreignKeyCheck()).toEqual([]);
    });

    it('keeps every cover row when object deletion fails, and completes on a second pass', async () => {
      const access = await eventAccess();
      const ids = await seedEventCoverGraph(testEnv.DB, access.event.id);
      await seedCoverObjects(access.event.id, ids.renderSetId, ids.draftId);
      const failing = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete')
        .mockRejectedValueOnce(new Error('R2 unavailable'));

      await expect(purgeSettled(access.event.id, new Date('2026-08-04T12:00:00.000Z')))
        .rejects.toThrow();
      failing.mockRestore();

      const event = await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?')
        .bind(access.event.id).first<{ deleted_at: string | null }>();
      expect(event?.deleted_at).toBeTruthy();
      // Nothing is removed ahead of its object: the inventory is the only record
      // that the object exists, so it has to survive for the retry to find it.
      for (const table of EVENT_COVER_TABLES) {
        expect(await countRows(table, access.event.id), `${table} rows after failure`).toBeGreaterThan(0);
      }
      // The fences were already settled, so the retry resumes at `r2` rather
      // than paying for the whole platform reconciliation again.
      expect(await testEnv.DB.prepare(`
        SELECT phase, workflow_binding FROM event_cover_purge_progress WHERE event_id = ?
      `).bind(access.event.id).first()).toEqual({
        phase: 'r2', workflow_binding: 'terminal-proof-v2:',
      });

      const retry = purgeAccessors({
        [ids.workflowInstanceId]: { kind: 'unknown', telemetry: 'must-not-recheck' },
      });
      await reconcileEventCoverPurge(
        testEnv, access.event.id, new Date('2026-08-04T12:05:00.000Z'), retry.accessors,
      );
      expect(retry.calls).toEqual([]);
      expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
        .bind(access.event.id).first()).toBeNull();
      expect(await coverPrefixKeys(access.event.id)).toEqual([]);
      expect(await foreignKeyCheck()).toEqual([]);
    });
  });
});

/**
 * The bounded cover sweep.
 *
 * Every case here is really one of two questions: does an object leave R2 before
 * the only row that knows about it, and does a deadline release something that
 * some other owner is still entitled to? The second is why so many of these are
 * negative assertions — the sweep's job is as much about what it refuses to
 * collect as about what it collects.
 */
describe('bounded cover storage sweep', () => {
  const NOW = new Date('2026-08-10T12:00:00.000Z');
  const PAST = '2026-08-01T00:00:00.000Z';
  const FUTURE = '2026-08-20T00:00:00.000Z';
  const HEX = 'a'.repeat(64);

  let access: Access;

  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  const prefix = () => `events/${access.event.id}/cover`;

  async function put(key: string) {
    await testEnv.MEDIA_BUCKET.put(key, png());
    return key;
  }

  async function exists(key: string) {
    return await testEnv.MEDIA_BUCKET.head(key) !== null;
  }

  async function insertMaster(id: string, options: { cleanupAfter?: string | null } = {}) {
    const key = `${prefix()}/masters/${id}.webp`;
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_masters (
        id, event_id, object_key, mime_type, byte_size, width, height, sha256,
        normalization_version, normalization_rung, created_at, cleanup_after
      ) VALUES (?, ?, ?, 'image/webp', 900000, 2400, 1600, ?, 1, 1, ?, ?)
    `).bind(id, access.event.id, key, HEX, PAST, options.cleanupAfter ?? null).run();
    return put(key);
  }

  async function insertDraft(id: string, options: {
    state: string;
    expiresAt?: string;
    rawKey?: string | null;
    masterId?: string | null;
  }) {
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_drafts (
        id, event_id, source, state, draft_intent_id, request_sha256, draft_revision,
        raw_object_key, master_id, created_at, updated_at, expires_at
      ) VALUES (?, ?, 'new_upload', ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).bind(
      id, access.event.id, options.state, `intent-${id}`, HEX,
      options.rawKey ?? null, options.masterId ?? null, PAST, PAST, options.expiresAt ?? PAST,
    ).run();
  }

  async function insertSet(id: string, options: {
    state: string;
    masterId: string;
    draftId?: string | null;
    cleanupAfter?: string | null;
  }) {
    const frozen = options.state === 'ready' || options.state === 'active';
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_render_sets (
        id, event_id, master_id, draft_id, recipe_json, recipe_sha256, state,
        required_slots, created_at, cleanup_after
      ) VALUES (?, ?, ?, ?, '{"effect":"natural"}', ?, ?, 12, ?, ?)
    `).bind(
      id, access.event.id, options.masterId, options.draftId ?? null,
      HEX, frozen ? 'staging' : options.state, PAST,
      options.cleanupAfter ?? null,
    ).run();
    if (!frozen) return;
    await testEnv.DB.batch(EVENT_COVER_PROFILES.flatMap((profile) => (
      ['webp', 'jpeg'] as const
    ).map((format) => testEnv.DB.prepare(`
      INSERT INTO event_cover_render_objects (
        id, render_set_id, event_id, profile_id, density, format, object_key,
        content_type, byte_size, width, height, quality_rung, sha256, created_at
      ) VALUES (?, ?, ?, ?, '1x', ?, ?, ?, 100, ?, ?, 1, ?, ?)
    `).bind(
      `${id}-${profile.id}-${format}`,
      id,
      access.event.id,
      profile.id,
      format,
      `${prefix()}/rendered/${id}/${profile.id}-1x.${format}`,
      format === 'webp' ? 'image/webp' : 'image/jpeg',
      profile.width,
      profile.height,
      HEX,
      PAST,
    ))));
    await testEnv.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = ?, manifest_sha256 = ?, ready_at = ?,
          published_revision = ?, published_at = ?
      WHERE id = ?
    `).bind(
      options.state,
      HEX,
      PAST,
      options.state === 'active' ? 1 : null,
      options.state === 'active' ? PAST : null,
      id,
    ).run();
  }

  async function pointEventToUpload(setId: string, masterId: string): Promise<void> {
    const master = await testEnv.DB.prepare(`
      SELECT object_key FROM event_cover_masters WHERE id = ? AND event_id = ?
    `).bind(masterId, access.event.id).first<{ object_key: string }>();
    if (!master) throw new Error('Expected cover master fixture.');
    await testEnv.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
      WHERE id = ?
    `).bind(
      '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
      master.object_key,
      setId,
      access.event.id,
    ).run();
  }

  async function insertRenderObject(id: string, setId: string, profile: string) {
    const key = `${prefix()}/rendered/${setId}/${profile}-1x.jpeg`;
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_render_objects (
        id, render_set_id, event_id, profile_id, density, format, object_key,
        content_type, byte_size, width, height, quality_rung, sha256, created_at
      ) VALUES (?, ?, ?, ?, '1x', 'jpeg', ?, 'image/jpeg', 120000, 620, 420, 1, ?, ?)
    `).bind(id, setId, access.event.id, profile, key, HEX, PAST).run();
    return put(key);
  }

  async function insertReceipt(operationId: string, options: {
    status: string;
    /** NOT NULL in the schema: every receipt carries the deadline its status earns. */
    expiresAt: string;
    draftId?: string | null;
    setId?: string | null;
    retryable?: number;
    failureCode?: string | null;
    updatedAt?: string;
    expectedRevision?: number;
  }) {
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (
        event_id, operation_id, draft_id, render_set_id, request_sha256, action,
        expected_revision, status, workflow_instance_id, dependency_versions_json,
        completed_profiles, required_profiles, failure_code, retryable, dispatch_state,
        dispatch_generation, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'publish', ?, ?, ?, '{"tonalEffect":1}', 0, 6, ?, ?, 'confirmed', 1, ?, ?, ?)
    `).bind(
      access.event.id, operationId, options.draftId ?? null, options.setId ?? null, HEX,
      options.expectedRevision ?? 0, options.status, `instance-${operationId}`,
      options.failureCode ?? null,
      options.retryable ?? 0, PAST, options.updatedAt ?? PAST, options.expiresAt,
    ).run();
  }

  async function insertBackfillJob(id: string, runId: string, options: {
    status: string;
    masterId?: string | null;
    setId?: string | null;
    referenceReleaseAt?: string | null;
    expiresAt?: string | null;
    runExpiresAt?: string | null;
    retryable?: number;
    terminalAt?: string | null;
  }) {
    await testEnv.DB.prepare(`
      INSERT OR IGNORE INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at, expires_at)
      VALUES (?, 'execute', 'executing', ?, ?, ?)
    `).bind(runId, PAST, PAST, options.runExpiresAt ?? null).run();
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_backfill_jobs (
        id, run_id, event_id, expected_revision, legacy_key_fingerprint, master_id,
        render_set_id, workflow_instance_id, dispatch_state, dispatch_generation,
        status, dependency_versions_json, retryable, terminal_at, reference_release_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'confirmed', 1, ?, '{"tonalEffect":1}', ?, ?, ?, ?, ?, ?)
    `).bind(
      id, runId, access.event.id, HEX, options.masterId ?? null, options.setId ?? null,
      `backfill-${id}`, options.status, options.retryable ?? 0,
      options.terminalAt === undefined ? PAST : options.terminalAt,
      options.referenceReleaseAt ?? null, options.expiresAt ?? null, PAST, PAST,
    ).run();
  }

  async function insertFence(
    binding: 'COVER_RENDER_WORKFLOW' | 'COVER_BACKFILL_WORKFLOW',
    instanceId: string,
    options: {
      state?: 'open' | 'deletion-blocked'; generation?: number;
      expiresAt?: string; eventId?: string;
    } = {},
  ) {
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_workflow_fences (
        workflow_binding, workflow_instance_id, event_id, dispatch_generation,
        state, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      binding, instanceId, options.eventId ?? access.event.id, options.generation ?? 1,
      options.state ?? 'open', PAST, PAST, options.expiresAt ?? PAST,
    ).run();
  }

  async function draftState(id: string) {
    return testEnv.DB.prepare('SELECT state, raw_object_key, draft_revision FROM event_cover_drafts WHERE id = ?')
      .bind(id).first<{ state: string; raw_object_key: string | null; draft_revision: number }>();
  }

  it('expires a stale draft and releases its raw bytes only once R2 absence is proven', async () => {
    const raw = await put(`${prefix()}/raw/draft-stale`);
    await insertDraft('draft-stale', { state: 'ready', expiresAt: PAST, rawKey: raw });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.draftsExpired).toBe(1);
    expect(await draftState('draft-stale')).toMatchObject({
      state: 'expired', raw_object_key: null, draft_revision: 2,
    });
    expect(await exists(raw)).toBe(false);
  });

  it('keeps the raw pointer charged when the object cannot be deleted', async () => {
    const raw = await put(`${prefix()}/raw/draft-stuck`);
    await insertDraft('draft-stuck', { state: 'failed', rawKey: raw });
    const failing = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete')
      .mockRejectedValueOnce(new Error('R2 unavailable'));

    await cleanupEventCovers(testEnv, NOW);
    failing.mockRestore();

    // Still charged against the event aggregate, because the bytes are still there.
    expect((await draftState('draft-stuck'))?.raw_object_key).toBe(raw);
    expect(await exists(raw)).toBe(true);

    await cleanupEventCovers(testEnv, NOW);
    expect((await draftState('draft-stuck'))?.raw_object_key).toBeNull();
    expect(await exists(raw)).toBe(false);
  });

  it('never expires a publishing draft, whatever its own expiry says', async () => {
    await insertDraft('draft-publishing', { state: 'publishing', expiresAt: PAST });
    await insertReceipt('op-retryable', {
      status: 'failed', retryable: 1, expiresAt: FUTURE, draftId: 'draft-publishing',
    });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.draftsExpired).toBe(0);
    // Publication ownership is what returns it to `ready` — never a sweep.
    expect((await draftState('draft-publishing'))?.state).toBe('publishing');
    expect(await countRows('event_cover_publish_receipts', access.event.id)).toBe(1);
  });

  it('settles a retryable publication exactly at expiry before admitting a competitor', async () => {
    const terminalAt = '2026-08-09T12:00:00.000Z';
    const expiresAt = NOW.toISOString();
    const terminalReceiptExpiry = '2026-08-11T12:00:00.000Z';
    const fenceExpiry = '2026-09-10T12:00:00.000Z';
    const setCleanupAfter = '2026-08-17T12:00:00.000Z';
    const draftExpiry = '2026-10-20T00:00:00.000Z';
    const raw = await put(`${prefix()}/raw/draft-retry-expiry`);
    await insertMaster('master-retry-expiry');
    await insertDraft('draft-retry-expiry', {
      state: 'publishing', expiresAt: draftExpiry, rawKey: raw,
      masterId: 'master-retry-expiry',
    });
    await insertSet('set-retry-expiry', {
      state: 'staging', masterId: 'master-retry-expiry', draftId: 'draft-retry-expiry',
    });
    const rendered = await insertRenderObject(
      'object-retry-expiry', 'set-retry-expiry', 'wide-expanded',
    );
    await insertReceipt('op-retry-expiry', {
      status: 'failed', retryable: 1, expiresAt,
      draftId: 'draft-retry-expiry', setId: 'set-retry-expiry',
      failureCode: 'COVER_RENDER_UNAVAILABLE', updatedAt: terminalAt,
    });
    // A coincidentally correct legacy deadline is not proof by itself: cleanup
    // must also move the fence's owner-relative terminal clock.
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-op-retry-expiry', {
      expiresAt: fenceExpiry,
    });

    const insertCompetitor = () => insertReceipt('op-competitor', {
      status: 'queued', expiresAt: draftExpiry,
    });
    const calls: string[] = [];
    let platformStatus: 'paused' | 'terminated' = 'paused';
    let signalTerminateStarted!: () => void;
    let releaseTerminate!: () => void;
    const terminateStarted = new Promise<void>((resolve) => { signalTerminateStarted = resolve; });
    const terminateGate = new Promise<void>((resolve) => { releaseTerminate = resolve; });
    const workflow = {
      async lookup(id: string): Promise<CoverWorkflowLookup> {
        calls.push(`lookup:${id}`);
        return { kind: 'status', status: platformStatus };
      },
      async create(id: string) { calls.push(`create:${id}`); },
      async resume(id: string) { calls.push(`resume:${id}`); },
      async restart(id: string) { calls.push(`restart:${id}`); },
      async terminate(id: string) {
        calls.push(`terminate:${id}`);
        signalTerminateStarted();
        await terminateGate;
        platformStatus = 'terminated';
      },
    };

    await cleanupEventCovers(testEnv, new Date(NOW.getTime() - 1), workflow);
    expect(calls).toEqual([]);
    await expect(insertCompetitor()).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await testEnv.DB.prepare(`
      SELECT retryable, updated_at, expires_at FROM event_cover_publish_receipts
      WHERE event_id = ? AND operation_id = 'op-retry-expiry'
    `).bind(access.event.id).first()).toEqual({
      retryable: 1, updated_at: terminalAt, expires_at: expiresAt,
    });
    expect(await draftState('draft-retry-expiry')).toMatchObject({
      state: 'publishing', draft_revision: 1,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, abandoned_at, cleanup_after FROM event_cover_render_sets
      WHERE id = 'set-retry-expiry'
    `).first()).toEqual({ state: 'staging', abandoned_at: null, cleanup_after: null });

    const transition = cleanupEventCovers(testEnv, NOW, workflow);
    expect(await Promise.race([
      terminateStarted.then(() => 'started' as const),
      transition.then(() => 'completed' as const),
    ])).toBe('started');

    // Expiry claimed this exact generation and held its fence, but has not
    // released one-preparation ownership while the paused instance can resume.
    expect(calls).toEqual([
      'lookup:instance-op-retry-expiry',
      'lookup:instance-op-retry-expiry',
      'terminate:instance-op-retry-expiry',
    ]);
    expect(await testEnv.DB.prepare(`
      SELECT status, retryable, failure_code, dispatch_state, dispatch_generation,
        last_dispatch_at, updated_at, expires_at, draft_id, render_set_id
      FROM event_cover_publish_receipts
      WHERE event_id = ? AND operation_id = 'op-retry-expiry'
    `).bind(access.event.id).first()).toEqual({
      status: 'failed', retryable: 1, failure_code: 'COVER_RENDER_UNAVAILABLE',
      dispatch_state: 'resuming', dispatch_generation: 2,
      last_dispatch_at: expiresAt, updated_at: expiresAt, expires_at: expiresAt,
      draft_id: 'draft-retry-expiry', render_set_id: 'set-retry-expiry',
    });
    expect(await draftState('draft-retry-expiry')).toMatchObject({
      state: 'publishing', raw_object_key: raw, draft_revision: 1,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, abandoned_reason, abandoned_at, cleanup_after
      FROM event_cover_render_sets WHERE id = 'set-retry-expiry'
    `).first()).toEqual({
      state: 'staging', abandoned_reason: null, abandoned_at: null, cleanup_after: null,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, dispatch_generation, updated_at, expires_at
      FROM event_cover_workflow_fences
      WHERE workflow_instance_id = 'instance-op-retry-expiry'
    `).first()).toEqual({
      state: 'open', dispatch_generation: 2,
      updated_at: expiresAt, expires_at: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
    });
    await expect(insertCompetitor()).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await exists(rendered)).toBe(true);

    releaseTerminate();
    await transition;

    expect(await testEnv.DB.prepare(`
      SELECT status, retryable, failure_code, dispatch_state, dispatch_generation,
        updated_at, expires_at, draft_id, render_set_id
      FROM event_cover_publish_receipts
      WHERE event_id = ? AND operation_id = 'op-retry-expiry'
    `).bind(access.event.id).first()).toEqual({
      status: 'failed', retryable: 0, failure_code: 'COVER_RENDER_UNAVAILABLE',
      dispatch_state: 'failed', dispatch_generation: 2,
      updated_at: expiresAt, expires_at: terminalReceiptExpiry,
      draft_id: 'draft-retry-expiry', render_set_id: 'set-retry-expiry',
    });
    expect(await draftState('draft-retry-expiry')).toMatchObject({
      state: 'ready', raw_object_key: raw, draft_revision: 2,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, abandoned_reason, abandoned_at, cleanup_after
      FROM event_cover_render_sets WHERE id = 'set-retry-expiry'
    `).first()).toEqual({
      state: 'abandoned', abandoned_reason: 'COVER_RENDER_UNAVAILABLE',
      abandoned_at: expiresAt, cleanup_after: setCleanupAfter,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, updated_at, expires_at, dispatch_generation
      FROM event_cover_workflow_fences WHERE workflow_instance_id = 'instance-op-retry-expiry'
    `).first()).toEqual({
      state: 'open', updated_at: expiresAt, expires_at: fenceExpiry, dispatch_generation: 2,
    });
    expect(calls).toEqual([
      'lookup:instance-op-retry-expiry',
      'lookup:instance-op-retry-expiry',
      'terminate:instance-op-retry-expiry',
      'lookup:instance-op-retry-expiry',
    ]);
    expect(await exists(raw)).toBe(true);
    expect(await exists(rendered)).toBe(true);
    expect(await countRows('event_cover_render_objects', access.event.id)).toBe(1);

    // The partial unique index remains the authority: the same insertion that
    // failed one millisecond earlier succeeds only after the atomic settlement.
    await insertCompetitor();
    const settledGraph = (await testEnv.DB.batch([
      testEnv.DB.prepare(`
        SELECT retryable, updated_at, expires_at FROM event_cover_publish_receipts
        WHERE event_id = ? AND operation_id = 'op-retry-expiry'
      `).bind(access.event.id),
      testEnv.DB.prepare(`
        SELECT state, draft_revision, updated_at FROM event_cover_drafts
        WHERE id = 'draft-retry-expiry'
      `),
      testEnv.DB.prepare(`
        SELECT state, abandoned_reason, abandoned_at, cleanup_after
        FROM event_cover_render_sets WHERE id = 'set-retry-expiry'
      `),
      testEnv.DB.prepare(`
        SELECT state, updated_at, expires_at FROM event_cover_workflow_fences
        WHERE workflow_instance_id = 'instance-op-retry-expiry'
      `),
    ])).map((result) => result.results);

    const replay = await cleanupEventCovers(testEnv, NOW, workflow);
    expect(replay).toMatchObject({
      draftsExpired: 0, receiptsExpired: 0, setsAbandoned: 0,
      renderObjectsDeleted: 0, setsDeleted: 0, remainder: false,
    });
    expect((await testEnv.DB.batch([
      testEnv.DB.prepare(`
        SELECT retryable, updated_at, expires_at FROM event_cover_publish_receipts
        WHERE event_id = ? AND operation_id = 'op-retry-expiry'
      `).bind(access.event.id),
      testEnv.DB.prepare(`
        SELECT state, draft_revision, updated_at FROM event_cover_drafts
        WHERE id = 'draft-retry-expiry'
      `),
      testEnv.DB.prepare(`
        SELECT state, abandoned_reason, abandoned_at, cleanup_after
        FROM event_cover_render_sets WHERE id = 'set-retry-expiry'
      `),
      testEnv.DB.prepare(`
        SELECT state, updated_at, expires_at FROM event_cover_workflow_fences
        WHERE workflow_instance_id = 'instance-op-retry-expiry'
      `),
    ])).map((result) => result.results)).toEqual(settledGraph);

    await cleanupEventCovers(
      testEnv, new Date('2026-09-10T11:59:59.999Z'), workflow,
    );
    expect(await fenceRow('instance-op-retry-expiry')).not.toBeNull();
    expect(await exists(rendered)).toBe(true);

    await cleanupEventCovers(testEnv, new Date(fenceExpiry), workflow);
    expect(await fenceRow('instance-op-retry-expiry')).toBeNull();
    expect(await testEnv.DB.prepare(`
      SELECT operation_id FROM event_cover_publish_receipts
      WHERE event_id = ? AND operation_id = 'op-retry-expiry'
    `).bind(access.event.id).first()).toBeNull();
    expect(await exists(rendered)).toBe(false);
    expect(await exists(raw)).toBe(true);
  });

  it('re-proves terminal state after claiming an initially terminal retryable publication', async () => {
    const expiresAt = NOW.toISOString();
    await insertMaster('master-retry-expiry-race');
    await insertDraft('draft-retry-expiry-race', {
      state: 'publishing', expiresAt: FUTURE, masterId: 'master-retry-expiry-race',
    });
    await insertSet('set-retry-expiry-race', {
      state: 'staging', masterId: 'master-retry-expiry-race',
      draftId: 'draft-retry-expiry-race',
    });
    await insertReceipt('op-retry-expiry-race', {
      status: 'failed', retryable: 1, expiresAt,
      draftId: 'draft-retry-expiry-race', setId: 'set-retry-expiry-race',
      failureCode: 'COVER_RENDER_UNAVAILABLE', updatedAt: '2026-08-09T12:00:00.000Z',
    });
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-op-retry-expiry-race', {
      expiresAt: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
    });

    const calls: string[] = [];
    const observations = ['complete', 'running', 'terminated'] as const;
    let lookupIndex = 0;
    const workflow = {
      async lookup(id: string): Promise<CoverWorkflowLookup> {
        calls.push(`lookup:${id}`);
        return { kind: 'status', status: observations[lookupIndex++] ?? 'unknown' };
      },
      async create(id: string) { calls.push(`create:${id}`); },
      async resume(id: string) { calls.push(`resume:${id}`); },
      async restart(id: string) { calls.push(`restart:${id}`); },
      async terminate(id: string) { calls.push(`terminate:${id}`); },
    };

    await cleanupEventCovers(testEnv, NOW, workflow);

    expect(calls).toEqual([
      'lookup:instance-op-retry-expiry-race',
      'lookup:instance-op-retry-expiry-race',
      'terminate:instance-op-retry-expiry-race',
      'lookup:instance-op-retry-expiry-race',
    ]);
    expect(await testEnv.DB.prepare(`
      SELECT retryable, dispatch_state, dispatch_generation, expires_at
      FROM event_cover_publish_receipts
      WHERE event_id = ? AND operation_id = 'op-retry-expiry-race'
    `).bind(access.event.id).first()).toEqual({
      retryable: 0, dispatch_state: 'failed', dispatch_generation: 2,
      expires_at: '2026-08-11T12:00:00.000Z',
    });
    expect(await draftState('draft-retry-expiry-race')).toMatchObject({
      state: 'ready', draft_revision: 2,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, cleanup_after FROM event_cover_render_sets
      WHERE id = 'set-retry-expiry-race'
    `).first()).toEqual({
      state: 'abandoned', cleanup_after: '2026-08-17T12:00:00.000Z',
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, dispatch_generation, expires_at
      FROM event_cover_workflow_fences
      WHERE workflow_instance_id = 'instance-op-retry-expiry-race'
    `).first()).toEqual({
      state: 'open', dispatch_generation: 2,
      expires_at: '2026-09-10T12:00:00.000Z',
    });
  });

  it('settles an expired paused revision loser as conflict after terminal proof', async () => {
    const expiresAt = NOW.toISOString();
    await insertMaster('master-retry-expiry-conflict');
    await insertDraft('draft-retry-expiry-conflict', {
      state: 'publishing', expiresAt: FUTURE, masterId: 'master-retry-expiry-conflict',
    });
    await insertSet('set-retry-expiry-conflict', {
      state: 'staging', masterId: 'master-retry-expiry-conflict',
      draftId: 'draft-retry-expiry-conflict',
    });
    await insertReceipt('op-retry-expiry-conflict', {
      status: 'failed', retryable: 1, expiresAt, expectedRevision: 0,
      draftId: 'draft-retry-expiry-conflict', setId: 'set-retry-expiry-conflict',
      failureCode: 'COVER_RENDER_UNAVAILABLE', updatedAt: '2026-08-09T12:00:00.000Z',
    });
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-op-retry-expiry-conflict', {
      expiresAt: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
    });
    await testEnv.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = NULL, cover_render_set_id = NULL,
          cover_revision = 1
      WHERE id = ?
    `).bind(
      '{"version":1,"source":{"kind":"preset","presetId":"warm-linen","assetVersion":1},"effect":"natural"}',
      access.event.id,
    ).run();

    let platformStatus: 'paused' | 'terminated' = 'paused';
    const calls: string[] = [];
    const workflow = {
      async lookup(id: string): Promise<CoverWorkflowLookup> {
        calls.push(`lookup:${id}`);
        return { kind: 'status', status: platformStatus };
      },
      async create(id: string) { calls.push(`create:${id}`); },
      async resume(id: string) { calls.push(`resume:${id}`); },
      async restart(id: string) { calls.push(`restart:${id}`); },
      async terminate(id: string) {
        calls.push(`terminate:${id}`);
        platformStatus = 'terminated';
      },
    };

    await cleanupEventCovers(testEnv, NOW, workflow);

    expect(calls).toEqual([
      'lookup:instance-op-retry-expiry-conflict',
      'lookup:instance-op-retry-expiry-conflict',
      'terminate:instance-op-retry-expiry-conflict',
      'lookup:instance-op-retry-expiry-conflict',
    ]);
    expect(await testEnv.DB.prepare(`
      SELECT expected_revision, status, retryable, failure_code, dispatch_state,
        dispatch_generation, render_set_id, expires_at
      FROM event_cover_publish_receipts
      WHERE event_id = ? AND operation_id = 'op-retry-expiry-conflict'
    `).bind(access.event.id).first()).toEqual({
      expected_revision: 0, status: 'conflict', retryable: 0, failure_code: null,
      dispatch_state: 'resuming', dispatch_generation: 2, render_set_id: null,
      expires_at: '2026-08-11T12:00:00.000Z',
    });
    expect(await draftState('draft-retry-expiry-conflict')).toMatchObject({
      state: 'ready', draft_revision: 2,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, abandoned_reason, cleanup_after FROM event_cover_render_sets
      WHERE id = 'set-retry-expiry-conflict'
    `).first()).toEqual({
      state: 'abandoned', abandoned_reason: 'revision-conflict',
      cleanup_after: '2026-08-17T12:00:00.000Z',
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, dispatch_generation, expires_at FROM event_cover_workflow_fences
      WHERE workflow_instance_id = 'instance-op-retry-expiry-conflict'
    `).first()).toEqual({
      state: 'open', dispatch_generation: 2, expires_at: '2026-09-10T12:00:00.000Z',
    });
  });

  it('preserves an expired retryable publication byte-for-byte on unknown platform evidence', async () => {
    await insertMaster('master-retry-unknown');
    await insertDraft('draft-retry-unknown', {
      state: 'publishing', expiresAt: FUTURE, masterId: 'master-retry-unknown',
    });
    await insertSet('set-retry-unknown', {
      state: 'staging', masterId: 'master-retry-unknown', draftId: 'draft-retry-unknown',
    });
    await insertReceipt('op-retry-unknown', {
      status: 'failed', retryable: 1, expiresAt: NOW.toISOString(),
      draftId: 'draft-retry-unknown', setId: 'set-retry-unknown',
      failureCode: 'COVER_RENDER_UNAVAILABLE', updatedAt: PAST,
    });
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-op-retry-unknown');
    const before = (await testEnv.DB.batch([
      testEnv.DB.prepare(`
        SELECT * FROM event_cover_publish_receipts WHERE operation_id = 'op-retry-unknown'
      `),
      testEnv.DB.prepare(`SELECT * FROM event_cover_drafts WHERE id = 'draft-retry-unknown'`),
      testEnv.DB.prepare(`SELECT * FROM event_cover_render_sets WHERE id = 'set-retry-unknown'`),
      testEnv.DB.prepare(`
        SELECT * FROM event_cover_workflow_fences
        WHERE workflow_instance_id = 'instance-op-retry-unknown'
      `),
    ])).map((result) => result.results);
    const { accessors, calls } = purgeAccessors({
      'instance-op-retry-unknown': {
        kind: 'unknown', telemetry: 'cover_platform_lookup_failed',
      },
    });
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const summary = await cleanupEventCovers(testEnv, NOW, accessors.render);

      expect(summary.remainder).toBe(true);
      expect(calls).toEqual(['lookup:instance-op-retry-unknown']);
      expect((await testEnv.DB.batch([
        testEnv.DB.prepare(`
          SELECT * FROM event_cover_publish_receipts WHERE operation_id = 'op-retry-unknown'
        `),
        testEnv.DB.prepare(`SELECT * FROM event_cover_drafts WHERE id = 'draft-retry-unknown'`),
        testEnv.DB.prepare(`SELECT * FROM event_cover_render_sets WHERE id = 'set-retry-unknown'`),
        testEnv.DB.prepare(`
          SELECT * FROM event_cover_workflow_fences
          WHERE workflow_instance_id = 'instance-op-retry-unknown'
        `),
      ])).map((result) => result.results)).toEqual(before);
      await expect(insertReceipt('op-unknown-competitor', {
        status: 'queued', expiresAt: FUTURE,
      })).rejects.toThrow(/UNIQUE constraint failed/);
      expect(reported).toHaveBeenCalledTimes(1);
    } finally {
      reported.mockRestore();
    }
  });

  it('does not release another terminal winner graph after losing its settlement CAS', async () => {
    await insertMaster('master-retry-race');
    await insertDraft('draft-retry-race', {
      state: 'publishing', expiresAt: FUTURE, masterId: 'master-retry-race',
    });
    await insertSet('set-retry-race', {
      state: 'staging', masterId: 'master-retry-race', draftId: 'draft-retry-race',
    });
    await insertReceipt('op-retry-race', {
      status: 'failed', retryable: 1, expiresAt: NOW.toISOString(),
      draftId: 'draft-retry-race', setId: 'set-retry-race',
      failureCode: 'COVER_RENDER_UNAVAILABLE', updatedAt: PAST,
    });
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-op-retry-race', {
      expiresAt: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
    });
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences SET created_at = ?
      WHERE workflow_instance_id = 'instance-op-retry-race'
    `).bind('2026-08-10T12:00:00.001Z').run();
    let lookups = 0;
    const workflow = {
      async lookup(): Promise<CoverWorkflowLookup> {
        lookups += 1;
        if (lookups === 2) {
          // A different terminal writer wins after this cleanup's claim and
          // before its settlement. It owns its own graph/fence follow-through.
          await testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET retryable = 0, dispatch_state = 'failed',
                updated_at = ?, expires_at = ?
            WHERE operation_id = 'op-retry-race'
          `).bind(NOW.toISOString(), '2026-08-11T12:00:00.000Z').run();
          return { kind: 'status', status: 'terminated' };
        }
        return { kind: 'status', status: 'paused' };
      },
      async create() {},
      async resume() {},
      async restart() {},
      async terminate() {},
    };

    const summary = await cleanupEventCovers(testEnv, NOW, workflow);

    expect(summary.remainder).toBe(true);
    expect(lookups).toBe(2);
    expect(await testEnv.DB.prepare(`
      SELECT retryable, dispatch_state, dispatch_generation, draft_id, render_set_id
      FROM event_cover_publish_receipts WHERE operation_id = 'op-retry-race'
    `).first()).toEqual({
      retryable: 0, dispatch_state: 'failed', dispatch_generation: 2,
      draft_id: 'draft-retry-race', render_set_id: 'set-retry-race',
    });
    expect(await draftState('draft-retry-race')).toMatchObject({
      state: 'publishing', draft_revision: 1,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, abandoned_at, cleanup_after FROM event_cover_render_sets
      WHERE id = 'set-retry-race'
    `).first()).toEqual({ state: 'staging', abandoned_at: null, cleanup_after: null });
    expect(await fenceRow('instance-op-retry-race')).toEqual({
      state: 'open', expires_at: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
      dispatch_generation: 2,
    });
  });

  it('parks a young expiry reconciliation claim without a platform call', async () => {
    const claimAt = new Date(NOW.getTime() - 119_000).toISOString();
    await insertReceipt('op-retry-young', {
      status: 'failed', retryable: 1, expiresAt: NOW.toISOString(),
      failureCode: 'COVER_RENDER_UNAVAILABLE', updatedAt: claimAt,
    });
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET dispatch_state = 'resuming', last_dispatch_at = ?
      WHERE operation_id = 'op-retry-young'
    `).bind(claimAt).run();
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-op-retry-young', {
      expiresAt: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
    });
    const { accessors, calls } = purgeAccessors({
      'instance-op-retry-young': { kind: 'status', status: 'paused' },
    });

    const summary = await cleanupEventCovers(testEnv, NOW, accessors.render);

    expect(summary.remainder).toBe(true);
    expect(calls).toEqual([]);
    expect(await testEnv.DB.prepare(`
      SELECT retryable, dispatch_state, dispatch_generation, last_dispatch_at
      FROM event_cover_publish_receipts WHERE operation_id = 'op-retry-young'
    `).first()).toEqual({
      retryable: 1, dispatch_state: 'resuming', dispatch_generation: 1,
      last_dispatch_at: claimAt,
    });
    expect(await fenceRow('instance-op-retry-young')).toEqual({
      state: 'open', expires_at: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
      dispatch_generation: 1,
    });
  });

  it('bounds retryable publication expiry globally and is idempotent after draining', async () => {
    const count = MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS + 1;
    const terminalAt = '2026-08-09T12:00:00.000Z';
    const expiresAt = NOW.toISOString();
    const statements = Array.from({ length: count }, (_unused, index) => {
      const id = `retry-expiry-event-${index.toString().padStart(2, '0')}`;
      return testEnv.DB.prepare(`
        INSERT INTO events (
          id, slug, name, event_date, welcome_message,
          guest_access_expires_at, management_access_expires_at,
          purge_after, created_at
        ) VALUES (?, ?, 'Retry expiry', '2026-12-31', 'Welcome', ?, ?, ?, ?)
      `).bind(id, id, '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z',
        '2027-02-01T00:00:00.000Z', PAST);
    });
    const masters = Array.from({ length: count }, (_unused, index) => {
      const suffix = index.toString().padStart(2, '0');
      return testEnv.DB.prepare(`
        INSERT INTO event_cover_masters (
          id, event_id, object_key, mime_type, byte_size, width, height, sha256,
          normalization_version, normalization_rung, created_at
        ) VALUES (?, ?, ?, 'image/webp', 900000, 2400, 1600, ?, 1, 1, ?)
      `).bind(
        `retry-expiry-master-${suffix}`, `retry-expiry-event-${suffix}`,
        `events/retry-expiry-event-${suffix}/cover/masters/master.webp`, HEX, PAST,
      );
    });
    const drafts = Array.from({ length: count }, (_unused, index) => {
      const suffix = index.toString().padStart(2, '0');
      return testEnv.DB.prepare(`
        INSERT INTO event_cover_drafts (
          id, event_id, source, state, draft_intent_id, request_sha256,
          draft_revision, master_id, created_at, updated_at, expires_at
        ) VALUES (?, ?, 'new_upload', 'publishing', ?, ?, 1, ?, ?, ?, ?)
      `).bind(
        `retry-expiry-draft-${suffix}`, `retry-expiry-event-${suffix}`,
        `retry-expiry-intent-${suffix}`, HEX, `retry-expiry-master-${suffix}`,
        PAST, PAST, FUTURE,
      );
    });
    const sets = Array.from({ length: count }, (_unused, index) => {
      const suffix = index.toString().padStart(2, '0');
      return testEnv.DB.prepare(`
        INSERT INTO event_cover_render_sets (
          id, event_id, master_id, draft_id, recipe_json, recipe_sha256,
          state, required_slots, created_at
        ) VALUES (?, ?, ?, ?, '{"effect":"natural"}', ?, 'staging', 12, ?)
      `).bind(
        `retry-expiry-set-${suffix}`, `retry-expiry-event-${suffix}`,
        `retry-expiry-master-${suffix}`, `retry-expiry-draft-${suffix}`, HEX, PAST,
      );
    });
    const receipts = Array.from({ length: count }, (_unused, index) => {
      const suffix = index.toString().padStart(2, '0');
      return testEnv.DB.prepare(`
        INSERT INTO event_cover_publish_receipts (
          event_id, operation_id, draft_id, render_set_id, request_sha256,
          action, expected_revision, status, workflow_instance_id,
          dependency_versions_json, failure_code, retryable, dispatch_state,
          dispatch_generation, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, 'publish', 0, 'failed', ?, '{}',
          'COVER_RENDER_UNAVAILABLE', 1, 'confirmed', 1, ?, ?, ?)
      `).bind(
        `retry-expiry-event-${suffix}`, `retry-expiry-operation-${suffix}`,
        `retry-expiry-draft-${suffix}`, `retry-expiry-set-${suffix}`, HEX,
        `retry-expiry-instance-${suffix}`, terminalAt, terminalAt, expiresAt,
      );
    });
    const fences = Array.from({ length: count }, (_unused, index) => {
      const suffix = index.toString().padStart(2, '0');
      return testEnv.DB.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        ) VALUES ('COVER_RENDER_WORKFLOW', ?, ?, 1, 'open', ?, ?, ?)
      `).bind(
        `retry-expiry-instance-${suffix}`, `retry-expiry-event-${suffix}`,
        terminalAt, terminalAt, COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
      );
    });
    await testEnv.DB.batch([...statements, ...masters, ...drafts, ...sets]);
    await testEnv.DB.batch([...receipts, ...fences]);
    const platform = new Map(Array.from({ length: count }, (_unused, index) => [
      `retry-expiry-instance-${index.toString().padStart(2, '0')}`,
      'paused' as string,
    ]));
    const calls: string[] = [];
    const workflow = {
      async lookup(id: string): Promise<CoverWorkflowLookup> {
        calls.push(`lookup:${id}`);
        return { kind: 'status', status: platform.get(id) ?? 'unknown' };
      },
      async create(id: string) { calls.push(`create:${id}`); },
      async resume(id: string) { calls.push(`resume:${id}`); },
      async restart(id: string) { calls.push(`restart:${id}`); },
      async terminate(id: string) {
        calls.push(`terminate:${id}`);
        platform.set(id, 'terminated');
      },
    };

    const first = await cleanupEventCovers(testEnv, NOW, workflow);

    expect(first.remainder).toBe(true);
    expect(calls.filter((call) => call.startsWith('lookup:'))).toHaveLength(10);
    const settledPerPass = Math.floor(MAX_COVER_PURGE_FENCES_PER_PASS / 3);
    expect(calls.filter((call) => call.startsWith('terminate:'))).toHaveLength(settledPerPass);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_publish_receipts
      WHERE operation_id LIKE 'retry-expiry-operation-%' AND retryable = 0
    `).first()).toEqual({ count: settledPerPass });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count, MIN(dispatch_state) AS dispatch_state,
        MIN(dispatch_generation) AS dispatch_generation
      FROM event_cover_publish_receipts
      WHERE operation_id LIKE 'retry-expiry-operation-%' AND retryable = 1
    `).first()).toEqual({
      count: count - settledPerPass, dispatch_state: 'confirmed', dispatch_generation: 1,
    });

    const second = await cleanupEventCovers(testEnv, NOW, workflow);
    expect(second.remainder).toBe(false);
    expect(calls.filter((call) => call.startsWith('terminate:'))).toHaveLength(count);
    const drained = await testEnv.DB.prepare(`
      SELECT operation_id, retryable, dispatch_state, dispatch_generation,
        updated_at, expires_at
      FROM event_cover_publish_receipts
      WHERE operation_id LIKE 'retry-expiry-operation-%' ORDER BY operation_id
    `).all();
    expect(drained.results).toHaveLength(count);
    expect(drained.results.every((row) => (
      row.retryable === 0
      && row.dispatch_state === 'failed'
      && row.dispatch_generation === 2
      && row.updated_at === expiresAt
      && row.expires_at === '2026-08-11T12:00:00.000Z'
    ))).toBe(true);
    expect((await testEnv.DB.prepare(`
      SELECT dispatch_generation, updated_at, expires_at
      FROM event_cover_workflow_fences
      WHERE workflow_instance_id LIKE 'retry-expiry-instance-%'
    `).all()).results.every((row) => (
      row.dispatch_generation === 2
      && row.updated_at === expiresAt
      && row.expires_at === '2026-09-10T12:00:00.000Z'
    ))).toBe(true);

    const callCount = calls.length;
    const replay = await cleanupEventCovers(testEnv, NOW, workflow);
    expect(replay).toMatchObject({ receiptsExpired: 0, remainder: false });
    expect(calls).toHaveLength(callCount);
    expect((await testEnv.DB.prepare(`
      SELECT operation_id, retryable, dispatch_state, dispatch_generation,
        updated_at, expires_at
      FROM event_cover_publish_receipts
      WHERE operation_id LIKE 'retry-expiry-operation-%' ORDER BY operation_id
    `).all()).results).toEqual(drained.results);
  });

  it('drifts bounded windows past nonsettling two-read prefixes', async () => {
    const rowCount = 20;
    const dayMs = 24 * 60 * 60 * 1000;
    let firstDay = Math.ceil(NOW.getTime() / dayMs);
    while (firstDay % (rowCount * 2) !== 0) firstDay += 1;
    const passAt = (offset: number) => new Date((firstDay + offset) * dayMs);
    const expiresAt = passAt(0).toISOString();

    for (let index = 0; index < rowCount; index += 1) {
      const suffix = index.toString().padStart(2, '0');
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          INSERT INTO events (
            id, slug, name, event_date, welcome_message,
            guest_access_expires_at, management_access_expires_at,
            purge_after, created_at
          ) VALUES (?, ?, 'Retry drift', '2026-12-31', 'Welcome', ?, ?, ?, ?)
        `).bind(
          `retry-drift-event-${suffix}`, `retry-drift-event-${suffix}`,
          '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z',
          '2027-02-01T00:00:00.000Z', PAST,
        ),
        testEnv.DB.prepare(`
          INSERT INTO event_cover_masters (
            id, event_id, object_key, mime_type, byte_size, width, height, sha256,
            normalization_version, normalization_rung, created_at
          ) VALUES (?, ?, ?, 'image/webp', 900000, 2400, 1600, ?, 1, 1, ?)
        `).bind(
          `retry-drift-master-${suffix}`, `retry-drift-event-${suffix}`,
          `events/retry-drift-event-${suffix}/cover/masters/master.webp`, HEX, PAST,
        ),
        testEnv.DB.prepare(`
          INSERT INTO event_cover_drafts (
            id, event_id, source, state, draft_intent_id, request_sha256,
            draft_revision, master_id, created_at, updated_at, expires_at
          ) VALUES (?, ?, 'new_upload', 'publishing', ?, ?, 1, ?, ?, ?, ?)
        `).bind(
          `retry-drift-draft-${suffix}`, `retry-drift-event-${suffix}`,
          `retry-drift-intent-${suffix}`, HEX, `retry-drift-master-${suffix}`,
          PAST, PAST, '2099-01-01T00:00:00.000Z',
        ),
        testEnv.DB.prepare(`
          INSERT INTO event_cover_render_sets (
            id, event_id, master_id, draft_id, recipe_json, recipe_sha256,
            state, required_slots, created_at
          ) VALUES (?, ?, ?, ?, '{"effect":"natural"}', ?, 'staging', 12, ?)
        `).bind(
          `retry-drift-set-${suffix}`, `retry-drift-event-${suffix}`,
          `retry-drift-master-${suffix}`, `retry-drift-draft-${suffix}`, HEX, PAST,
        ),
        testEnv.DB.prepare(`
          INSERT INTO event_cover_publish_receipts (
            event_id, operation_id, draft_id, render_set_id, request_sha256,
            action, expected_revision, status, workflow_instance_id,
            dependency_versions_json, failure_code, retryable, dispatch_state,
            dispatch_generation, created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, 'publish', 0, 'failed', ?, '{}',
            'COVER_RENDER_UNAVAILABLE', 1, 'confirmed', 1, ?, ?, ?)
        `).bind(
          `retry-drift-event-${suffix}`, `retry-drift-operation-${suffix}`,
          `retry-drift-draft-${suffix}`, `retry-drift-set-${suffix}`, HEX,
          `retry-drift-instance-${suffix}`, PAST, PAST, expiresAt,
        ),
        testEnv.DB.prepare(`
          INSERT INTO event_cover_workflow_fences (
            workflow_binding, workflow_instance_id, event_id, dispatch_generation,
            state, created_at, updated_at, expires_at
          ) VALUES ('COVER_RENDER_WORKFLOW', ?, ?, 1, 'open', ?, ?, ?)
        `).bind(
          `retry-drift-instance-${suffix}`, `retry-drift-event-${suffix}`,
          PAST, PAST, COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
        ),
      ]);
    }

    const prefixIndexes = new Set([0, 1, 2, 3, 4, 10, 11, 12, 13, 14]);
    const lookupCounts = new Map<string, number>();
    const calls: string[] = [];
    const workflow = {
      async lookup(id: string): Promise<CoverWorkflowLookup> {
        calls.push(id);
        const index = Number(id.slice(-2));
        if (prefixIndexes.has(index)) {
          const count = (lookupCounts.get(id) ?? 0) + 1;
          lookupCounts.set(id, count);
          return count % 2 === 1
            ? { kind: 'status', status: 'complete' }
            : { kind: 'unknown', telemetry: 'cover_platform_unknown' };
        }
        return index === 5
          ? { kind: 'status', status: 'complete' }
          : { kind: 'unknown', telemetry: 'cover_platform_unknown' };
      },
      async create() {},
      async resume() {},
      async restart() {},
      async terminate() {},
    };
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await cleanupEventCovers(testEnv, passAt(0), workflow);
      expect(new Set(calls)).toEqual(new Set(Array.from({ length: 5 }, (_unused, index) => (
        `retry-drift-instance-${index.toString().padStart(2, '0')}`
      ))));
      calls.length = 0;

      await cleanupEventCovers(testEnv, passAt(1), workflow);
      expect(new Set(calls)).toEqual(new Set(Array.from({ length: 5 }, (_unused, index) => (
        `retry-drift-instance-${(index + 10).toString().padStart(2, '0')}`
      ))));
      calls.length = 0;

      await cleanupEventCovers(testEnv, passAt(2), workflow);
      expect(calls).toContain('retry-drift-instance-05');
      expect(await testEnv.DB.prepare(`
        SELECT retryable, dispatch_state, dispatch_generation
        FROM event_cover_publish_receipts
        WHERE operation_id = 'retry-drift-operation-05'
      `).first()).toEqual({
        retryable: 0, dispatch_state: 'failed', dispatch_generation: 2,
      });
      expect(await testEnv.DB.prepare(`
        SELECT count(*) AS count FROM event_cover_publish_receipts
        WHERE operation_id IN (
          'retry-drift-operation-00', 'retry-drift-operation-01',
          'retry-drift-operation-02', 'retry-drift-operation-03',
          'retry-drift-operation-04', 'retry-drift-operation-10',
          'retry-drift-operation-11', 'retry-drift-operation-12',
          'retry-drift-operation-13', 'retry-drift-operation-14'
        ) AND retryable = 1
      `).first()).toEqual({ count: 10 });
    } finally {
      reported.mockRestore();
    }
  });

  it('rotates the full bounded window past unchanged unknown expiry rows', async () => {
    const unknownCount = 20;
    const total = unknownCount + 1;
    const dayMs = 24 * 60 * 60 * 1000;
    let firstDay = Math.ceil(NOW.getTime() / dayMs);
    const windows = Math.ceil(total / MAX_COVER_PURGE_FENCES_PER_PASS);
    while (firstDay % (total * windows) !== 0) firstDay += 1;
    const passAt = (offset: number) => new Date((firstDay + offset) * dayMs);
    const expiresAt = passAt(0).toISOString();
    const events = Array.from({ length: total }, (_unused, index) => {
      const suffix = index.toString().padStart(2, '0');
      return testEnv.DB.prepare(`
        INSERT INTO events (
          id, slug, name, event_date, welcome_message,
          guest_access_expires_at, management_access_expires_at,
          purge_after, created_at
        ) VALUES (?, ?, 'Retry rotation', '2026-12-31', 'Welcome', ?, ?, ?, ?)
      `).bind(
        `retry-rotation-event-${suffix}`, `retry-rotation-event-${suffix}`,
        '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z',
        '2027-02-01T00:00:00.000Z', PAST,
      );
    });
    const receipts = Array.from({ length: total }, (_unused, index) => {
      const suffix = index.toString().padStart(2, '0');
      const terminal = index === unknownCount;
      return testEnv.DB.prepare(`
        INSERT INTO event_cover_publish_receipts (
          event_id, operation_id, draft_id, render_set_id, request_sha256,
          action, expected_revision, status, workflow_instance_id,
          dependency_versions_json, failure_code, retryable, dispatch_state,
          dispatch_generation, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, 'publish', 0, 'failed', ?, '{}',
          'COVER_RENDER_UNAVAILABLE', 1, 'confirmed', 1, ?, ?, ?)
      `).bind(
        `retry-rotation-event-${suffix}`, `retry-rotation-operation-${suffix}`,
        terminal ? 'retry-rotation-draft-20' : null,
        terminal ? 'retry-rotation-set-20' : null,
        HEX, `retry-rotation-instance-${suffix}`, PAST, PAST, expiresAt,
      );
    });
    const fences = Array.from({ length: total }, (_unused, index) => {
      const suffix = index.toString().padStart(2, '0');
      return testEnv.DB.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        ) VALUES ('COVER_RENDER_WORKFLOW', ?, ?, 1, 'open', ?, ?, ?)
      `).bind(
        `retry-rotation-instance-${suffix}`, `retry-rotation-event-${suffix}`,
        PAST, PAST, COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
      );
    });
    await testEnv.DB.batch(events);
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO event_cover_masters (
          id, event_id, object_key, mime_type, byte_size, width, height, sha256,
          normalization_version, normalization_rung, created_at
        ) VALUES ('retry-rotation-master-20', 'retry-rotation-event-20',
          'events/retry-rotation-event-20/cover/masters/master.webp',
          'image/webp', 900000, 2400, 1600, ?, 1, 1, ?)
      `).bind(HEX, PAST),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_drafts (
          id, event_id, source, state, draft_intent_id, request_sha256,
          draft_revision, master_id, created_at, updated_at, expires_at
        ) VALUES ('retry-rotation-draft-20', 'retry-rotation-event-20',
          'new_upload', 'publishing', 'retry-rotation-intent-20', ?, 1,
          'retry-rotation-master-20', ?, ?, '2099-01-01T00:00:00.000Z')
      `).bind(HEX, PAST, PAST),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_render_sets (
          id, event_id, master_id, draft_id, recipe_json, recipe_sha256,
          state, required_slots, created_at
        ) VALUES ('retry-rotation-set-20', 'retry-rotation-event-20',
          'retry-rotation-master-20', 'retry-rotation-draft-20',
          '{"effect":"natural"}', ?, 'staging', 12, ?)
      `).bind(HEX, PAST),
    ]);
    await testEnv.DB.batch([...receipts, ...fences]);
    const unknownBefore = (await testEnv.DB.batch([
      testEnv.DB.prepare(`
        SELECT * FROM event_cover_publish_receipts
        WHERE operation_id < 'retry-rotation-operation-20' ORDER BY operation_id
      `),
      testEnv.DB.prepare(`
        SELECT * FROM event_cover_workflow_fences
        WHERE workflow_instance_id < 'retry-rotation-instance-20'
        ORDER BY workflow_instance_id
      `),
    ])).map((result) => result.results);
    const calls: string[] = [];
    const workflow = {
      async lookup(id: string): Promise<CoverWorkflowLookup> {
        calls.push(id);
        return id === 'retry-rotation-instance-20'
          ? { kind: 'status', status: 'complete' }
          : { kind: 'unknown', telemetry: 'cover_platform_unknown' };
      },
      async create() {},
      async resume() {},
      async restart() {},
      async terminate() {},
    };
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await cleanupEventCovers(testEnv, passAt(0), workflow);
      expect(calls).toEqual(Array.from({ length: 10 }, (_unused, index) => (
        `retry-rotation-instance-${index.toString().padStart(2, '0')}`
      )));
      expect(await testEnv.DB.prepare(`
        SELECT retryable FROM event_cover_publish_receipts
        WHERE operation_id = 'retry-rotation-operation-20'
      `).first()).toEqual({ retryable: 1 });

      calls.length = 0;
      await cleanupEventCovers(testEnv, passAt(1), workflow);
      expect(calls).toEqual(Array.from({ length: 10 }, (_unused, index) => (
        `retry-rotation-instance-${(index + 10).toString().padStart(2, '0')}`
      )));

      calls.length = 0;
      await cleanupEventCovers(testEnv, passAt(2), workflow);
      expect(calls).toContain('retry-rotation-instance-20');
      expect(await testEnv.DB.prepare(`
        SELECT retryable, dispatch_state, dispatch_generation
        FROM event_cover_publish_receipts
        WHERE operation_id = 'retry-rotation-operation-20'
      `).first()).toEqual({
        retryable: 0, dispatch_state: 'failed', dispatch_generation: 2,
      });
      expect((await testEnv.DB.batch([
        testEnv.DB.prepare(`
          SELECT * FROM event_cover_publish_receipts
          WHERE operation_id < 'retry-rotation-operation-20' ORDER BY operation_id
        `),
        testEnv.DB.prepare(`
          SELECT * FROM event_cover_workflow_fences
          WHERE workflow_instance_id < 'retry-rotation-instance-20'
          ORDER BY workflow_instance_id
        `),
      ])).map((result) => result.results)).toEqual(unknownBefore);
    } finally {
      reported.mockRestore();
    }
  });

  it('expires an owned draft whose own deadline passed before the retry window', async () => {
    const raw = await put(`${prefix()}/raw/draft-retry-expired`);
    await insertMaster('master-retry-expired');
    await insertDraft('draft-retry-expired', {
      state: 'publishing', expiresAt: PAST, rawKey: raw,
      masterId: 'master-retry-expired',
    });
    await insertSet('set-retry-expired', {
      state: 'staging', masterId: 'master-retry-expired', draftId: 'draft-retry-expired',
    });
    await insertReceipt('op-retry-expired', {
      status: 'failed', retryable: 1, expiresAt: NOW.toISOString(),
      draftId: 'draft-retry-expired', setId: 'set-retry-expired',
      failureCode: 'COVER_RENDER_UNAVAILABLE', updatedAt: '2026-08-09T12:00:00.000Z',
    });
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-op-retry-expired', {
      expiresAt: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
    });
    const workflow = purgeAccessors({
      'instance-op-retry-expired': { kind: 'status', status: 'complete' },
    }).accessors.render;

    await cleanupEventCovers(testEnv, NOW, workflow);

    expect(await draftState('draft-retry-expired')).toEqual({
      state: 'expired', raw_object_key: null, draft_revision: 2,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, abandoned_reason FROM event_cover_render_sets
      WHERE id = 'set-retry-expired'
    `).first()).toEqual({
      state: 'abandoned', abandoned_reason: 'COVER_RENDER_UNAVAILABLE',
    });
    expect(await exists(raw)).toBe(false);

    // Deletion follows the terminal draft transition in the same ordered pass,
    // and a replay cannot decrement the draft or delete the object twice.
    await cleanupEventCovers(testEnv, NOW, workflow);
    expect(await exists(raw)).toBe(false);
    expect(await draftState('draft-retry-expired')).toEqual({
      state: 'expired', raw_object_key: null, draft_revision: 2,
    });
  });

  /**
   * The other half of the rule above. A `publishing` draft is exempt from the
   * sweep because publication ownership is what releases it — so once that
   * owner's receipt has itself been swept, nothing is left that ever could, and
   * the draft, its master and its raw bytes stay uncollectable for the life of
   * the event with the host's one draft slot inside them.
   */
  it('releases a draft frozen by a publication whose receipt has been swept', async () => {
    await insertDraft('draft-stranded', { state: 'publishing', expiresAt: PAST });
    await insertDraft('draft-owned', { state: 'publishing', expiresAt: PAST });
    await insertReceipt('op-owner', {
      status: 'rendering', expiresAt: FUTURE, draftId: 'draft-owned',
    });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.strandedDraftsReleased).toBe(1);
    expect(await draftState('draft-stranded')).toMatchObject({
      state: 'failed', draft_revision: 2,
    });
    // A publication that still owns its draft keeps it frozen.
    expect((await draftState('draft-owned'))?.state).toBe('publishing');
  });

  it('deletes a preview file before its inventory row', async () => {
    await insertDraft('draft-done', { state: 'published' });
    const key = await put(`${prefix()}/previews/draft-done/natural-1.webp`);
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_draft_previews (
        id, draft_id, event_id, effect_id, recipe_version, state, object_key,
        mime_type, byte_size, width, height, ladder_rung, sha256, retryable,
        created_at, updated_at
      ) VALUES ('preview-a', 'draft-done', ?, 'natural', 1, 'ready', ?, 'image/webp',
                90000, 1280, 853, 1, ?, 0, ?, ?)
    `).bind(access.event.id, key, HEX, PAST, PAST).run();

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.previewsDeleted).toBe(1);
    expect(await exists(key)).toBe(false);
    expect(await countRows('event_cover_draft_previews', access.event.id)).toBe(0);
  });

  it('expires terminal receipts and leaves a nonterminal one alone', async () => {
    await insertReceipt('op-applied', { status: 'applied', expiresAt: PAST });
    await insertReceipt('op-conflict', { status: 'conflict', expiresAt: PAST });
    await insertReceipt('op-rendering', { status: 'rendering', expiresAt: PAST });
    await insertReceipt('op-not-due', { status: 'applied', expiresAt: FUTURE });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.receiptsExpired).toBe(2);
    const remaining = await testEnv.DB.prepare(
      'SELECT operation_id FROM event_cover_publish_receipts WHERE event_id = ? ORDER BY operation_id',
    ).bind(access.event.id).all<{ operation_id: string }>();
    expect(remaining.results.map((row) => row.operation_id)).toEqual(['op-not-due', 'op-rendering']);
  });

  it('releases backfill references at reference_release_at, then the job, then an emptied run', async () => {
    const master = await insertMaster('master-job');
    await insertSet('set-job', { state: 'retired', masterId: 'master-job' });
    await insertBackfillJob('job-a', 'run-a', {
      status: 'applied', masterId: 'master-job', setId: 'set-job',
      referenceReleaseAt: PAST, expiresAt: PAST, runExpiresAt: PAST,
    });
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_runs
      SET status = 'verified', verified_at = ?
      WHERE id = 'run-a'
    `).bind(PAST).run();

    const first = await cleanupEventCovers(testEnv, NOW);
    expect(first.backfillJobsReleased).toBe(1);
    // Released and deleted in the same pass: the release runs before the delete,
    // and the delete requires both pointers to be null.
    expect(await countRows('event_cover_backfill_jobs', access.event.id)).toBe(0);
    expect(await testEnv.DB.prepare('SELECT id FROM event_cover_backfill_runs WHERE id = ?')
      .bind('run-a').first()).toBeNull();
    expect(master).toContain('master-job');
  });

  it('releases due terminal job references but retains due nonterminal and replacement references', async () => {
    for (const masterId of [
      'master-terminal', 'master-live', 'master-replacement',
      'master-failed-inside', 'master-failed-null', 'master-failed-boundary',
    ]) {
      await insertMaster(masterId);
    }
    await insertBackfillJob('release-terminal', 'release-terminal-run', {
      status: 'applied', masterId: 'master-terminal', referenceReleaseAt: PAST,
    });
    await insertBackfillJob('release-live', 'release-live-run', {
      status: 'queued', masterId: 'master-live', referenceReleaseAt: PAST,
    });
    await insertBackfillJob('release-replacement', 'release-replacement-run', {
      status: 'needs_replacement', masterId: 'master-replacement', referenceReleaseAt: PAST,
    });
    await insertBackfillJob('release-failed-inside', 'release-failed-inside-run', {
      status: 'failed', retryable: 1, terminalAt: '2026-08-09T12:00:00.001Z',
      masterId: 'master-failed-inside', referenceReleaseAt: PAST,
    });
    await insertBackfillJob('release-failed-null', 'release-failed-null-run', {
      status: 'failed', retryable: 1, terminalAt: null,
      masterId: 'master-failed-null', referenceReleaseAt: PAST,
    });
    await insertBackfillJob('release-failed-boundary', 'release-failed-boundary-run', {
      status: 'failed', retryable: 1, terminalAt: '2026-08-09T12:00:00.000Z',
      masterId: 'master-failed-boundary', referenceReleaseAt: PAST,
    });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.backfillJobsReleased).toBe(2);
    expect((await testEnv.DB.prepare(`
      SELECT id, master_id FROM event_cover_backfill_jobs
      WHERE id LIKE 'release-%' ORDER BY id
    `).all()).results).toEqual([
      { id: 'release-failed-boundary', master_id: null },
      { id: 'release-failed-inside', master_id: 'master-failed-inside' },
      { id: 'release-failed-null', master_id: 'master-failed-null' },
      { id: 'release-live', master_id: 'master-live' },
      { id: 'release-replacement', master_id: 'master-replacement' },
      { id: 'release-terminal', master_id: null },
    ]);
  });

  it('keeps a backfill job that has not reached its reference release', async () => {
    await insertMaster('master-held');
    await insertBackfillJob('job-held', 'run-held', {
      status: 'applied', masterId: 'master-held', referenceReleaseAt: FUTURE, expiresAt: FUTURE,
    });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.backfillJobsReleased).toBe(0);
    expect(await countRows('event_cover_backfill_jobs', access.event.id)).toBe(1);
  });

  it('does not sweep legacy-expired active render or backfill fences', async () => {
    await insertReceipt('legacy-render', { status: 'rendering', expiresAt: FUTURE });
    await insertBackfillJob('legacy-backfill', 'legacy-run', { status: 'rendering' });
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-legacy-render');
    await insertFence('COVER_BACKFILL_WORKFLOW', 'backfill-legacy-backfill');

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.fencesDeleted).toBe(0);
    const fences = await testEnv.DB.prepare(`
      SELECT workflow_binding, workflow_instance_id FROM event_cover_workflow_fences
      ORDER BY workflow_binding
    `).all<{ workflow_binding: string; workflow_instance_id: string }>();
    expect(fences.results).toEqual([
      {
        workflow_binding: 'COVER_BACKFILL_WORKFLOW',
        workflow_instance_id: 'backfill-legacy-backfill',
      },
      {
        workflow_binding: 'COVER_RENDER_WORKFLOW',
        workflow_instance_id: 'instance-legacy-render',
      },
    ]);
  });

  it('does not sweep legacy-expired retryable failures inside their restart windows', async () => {
    const retryableAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    await insertReceipt('retry-render', {
      status: 'failed', retryable: 1, expiresAt: FUTURE,
    });
    await insertBackfillJob('retry-backfill', 'retry-run', { status: 'failed' });
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts SET updated_at = ? WHERE operation_id = ?
      `).bind(retryableAt, 'retry-render'),
      testEnv.DB.prepare(`
        UPDATE event_cover_backfill_jobs SET retryable = 1, terminal_at = ? WHERE id = ?
      `).bind(retryableAt, 'retry-backfill'),
    ]);
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-retry-render');
    await insertFence('COVER_BACKFILL_WORKFLOW', 'backfill-retry-backfill');

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.fencesDeleted).toBe(0);
    expect(await countRows('event_cover_workflow_fences', access.event.id)).toBe(2);
  });

  it('keeps expired open fences when owner proof is missing or generation-mismatched', async () => {
    await insertReceipt('mismatched-render', { status: 'applied', expiresAt: FUTURE });
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-mismatched-render', { generation: 2 });
    await insertFence('COVER_BACKFILL_WORKFLOW', 'ownerless-backfill');

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.fencesDeleted).toBe(0);
    expect(await countRows('event_cover_workflow_fences', access.event.id)).toBe(2);
  });

  it('keeps an expired deletion-blocked legacy fence while purge terminal proof is pending', async () => {
    // This is the pre-fd upgrade state: soft delete terminalized the ledger and
    // blocked the fence before platform reconciliation, but left the old dated
    // expiry in place. The failed ledger row is not proof that the instance the
    // purge still has to look up is terminal.
    await insertReceipt('legacy-purge', { status: 'failed', expiresAt: FUTURE });
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-legacy-purge', {
      state: 'deletion-blocked',
    });
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
        .bind(PAST, access.event.id),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_purge_progress (event_id, phase, created_at, updated_at)
        VALUES (?, 'fences', ?, ?)
      `).bind(access.event.id, PAST, PAST),
    ]);
    const objectKey = `events/${access.event.id}/cover/legacy-blocked.webp`;
    await testEnv.MEDIA_BUCKET.put(objectKey, png());

    const cleanup = await cleanupEventCovers(testEnv, NOW);

    expect(cleanup.fencesDeleted).toBe(0);
    expect(await countRows('event_cover_workflow_fences', access.event.id)).toBe(1);
    const { accessors, calls } = purgeAccessors({
      'instance-legacy-purge': { kind: 'unknown', telemetry: 'legacy-upgrade' },
    });

    const purge = await reconcileEventCoverPurge(testEnv, access.event.id, NOW, accessors);

    expect(calls).toEqual(['lookup:instance-legacy-purge']);
    expect(purge).toMatchObject({ phase: 'fences', remainder: true, inspected: 1 });
    expect(await testEnv.MEDIA_BUCKET.head(objectKey)).not.toBeNull();
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).not.toBeNull();
    expect(await fenceRow('instance-legacy-purge')).toMatchObject({
      state: 'deletion-blocked', expires_at: COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
    });
    expect(await testEnv.DB.prepare(`
      SELECT phase FROM event_cover_purge_progress WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ phase: 'fences' });
  });

  it.each(['fences', 'r2', 'relational'] as const)(
    'does not generically sweep an exact unsafe unversioned fence in %s',
    async (phase) => {
      const releasedAt = '2026-08-01T00:00:00.000Z';
      const exactUnsafeExpiry = '2026-09-01T00:00:00.000Z';
      await insertFence('COVER_RENDER_WORKFLOW', `exact-unsafe-${phase}`, {
        state: 'deletion-blocked', expiresAt: exactUnsafeExpiry,
      });
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_workflow_fences SET updated_at = ?
          WHERE workflow_instance_id = ?
        `).bind(releasedAt, `exact-unsafe-${phase}`),
        testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
          .bind(releasedAt, access.event.id),
        testEnv.DB.prepare(`
          INSERT INTO event_cover_purge_progress (event_id, phase, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).bind(access.event.id, phase, releasedAt, releasedAt),
      ]);

      const summary = await cleanupEventCovers(testEnv, new Date('2026-09-02T00:00:00.000Z'));

      expect(summary.fencesDeleted).toBe(0);
      expect(await fenceRow(`exact-unsafe-${phase}`)).toMatchObject({
        state: 'deletion-blocked', expires_at: exactUnsafeExpiry,
      });
    },
  );

  it('collects only a due canonical tagged blocked proof', async () => {
    const dueAt = '2026-09-01T00:00:00.000Z';
    const dueProof = `${dueAt}|cf2`;
    const cases = [
      { id: 'tag-valid-due', updatedAt: '2026-08-01T00:00:00.000Z', expiresAt: dueProof },
      { id: 'tag-valid-future', updatedAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-09-10T00:00:00.000Z|cf2' },
      { id: 'tag-plain', updatedAt: '2026-08-01T00:00:00.000Z', expiresAt: dueAt },
      { id: 'tag-wrong', updatedAt: '2026-08-01T00:00:00.000Z', expiresAt: `${dueAt}|cf3` },
      { id: 'tag-mismatch', updatedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-09-02T00:00:00.000Z|cf2' },
      { id: 'tag-duplicate', updatedAt: '2026-08-01T00:00:00.000Z', expiresAt: `${dueProof}|cf2` },
      { id: 'tag-malformed-clock', updatedAt: 'legacy-invalid', expiresAt: dueProof },
    ];
    for (const fixture of cases) {
      await insertFence('COVER_RENDER_WORKFLOW', fixture.id, {
        state: 'deletion-blocked', eventId: 'retired-event', expiresAt: fixture.expiresAt,
      });
      await testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences SET updated_at = ? WHERE workflow_instance_id = ?
      `).bind(fixture.updatedAt, fixture.id).run();
    }

    const summary = await cleanupEventCovers(testEnv, new Date('2026-09-02T00:00:00.000Z'));

    expect(summary.fencesDeleted).toBe(1);
    expect(await fenceRow('tag-valid-due')).toBeNull();
    const remaining = await testEnv.DB.prepare(`
      SELECT workflow_instance_id FROM event_cover_workflow_fences
      WHERE event_id = 'retired-event' ORDER BY workflow_instance_id
    `).all<{ workflow_instance_id: string }>();
    expect(remaining.results.map((row) => row.workflow_instance_id)).toEqual([
      'tag-duplicate',
      'tag-malformed-clock',
      'tag-mismatch',
      'tag-plain',
      'tag-valid-future',
      'tag-wrong',
    ]);
  });

  it('upgrades both legacy terminal owners to a full owner-relative fence retention window', async () => {
    const terminalAt = '2026-08-09T12:00:00.000Z';
    const terminalExpiry = '2026-09-09T12:00:00.000Z';
    await insertReceipt('owner-render', { status: 'applied', expiresAt: PAST });
    await insertBackfillJob('owner-backfill', 'owner-run', {
      status: 'applied', expiresAt: PAST, runExpiresAt: PAST,
    });
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts SET updated_at = ? WHERE operation_id = ?
      `).bind(terminalAt, 'owner-render'),
      testEnv.DB.prepare(`
        UPDATE event_cover_backfill_jobs SET terminal_at = ?, updated_at = ? WHERE id = ?
      `).bind(terminalAt, terminalAt, 'owner-backfill'),
    ]);
    await insertFence('COVER_RENDER_WORKFLOW', 'instance-owner-render');
    await insertFence('COVER_BACKFILL_WORKFLOW', 'backfill-owner-backfill');

    const held = await cleanupEventCovers(testEnv, NOW);

    expect(held).toMatchObject({ receiptsExpired: 0, fencesDeleted: 0 });
    expect(await countRows('event_cover_publish_receipts', access.event.id)).toBe(1);
    expect(await countRows('event_cover_backfill_jobs', access.event.id)).toBe(1);
    const upgraded = await testEnv.DB.prepare(`
      SELECT workflow_binding, expires_at, updated_at FROM event_cover_workflow_fences
      WHERE event_id = ? ORDER BY workflow_binding
    `).bind(access.event.id).all<{
      workflow_binding: string; expires_at: string; updated_at: string;
    }>();
    expect(upgraded.results).toEqual([
      {
        workflow_binding: 'COVER_BACKFILL_WORKFLOW',
        expires_at: terminalExpiry,
        updated_at: terminalAt,
      },
      {
        workflow_binding: 'COVER_RENDER_WORKFLOW',
        expires_at: terminalExpiry,
        updated_at: terminalAt,
      },
    ]);

    const almostDue = await cleanupEventCovers(
      testEnv, new Date('2026-09-09T11:59:59.999Z'),
    );
    expect(almostDue.fencesDeleted).toBe(0);

    const released = await cleanupEventCovers(testEnv, new Date(terminalExpiry));

    expect(released).toMatchObject({ receiptsExpired: 1, fencesDeleted: 2 });
    expect(await countRows('event_cover_workflow_fences', access.event.id)).toBe(0);
    expect(await countRows('event_cover_publish_receipts', access.event.id)).toBe(0);
    expect(await countRows('event_cover_backfill_jobs', access.event.id)).toBe(0);
  });

  it('keeps owner and fence aligned when reverse expiry order spills past the 100-row bound', async () => {
    const count = COVER_CLEANUP_ROWS_PER_CLASS + 1;
    const base = Date.parse(PAST);
    const terminalBase = Date.parse('2026-06-01T00:00:00.000Z');
    const receipts = Array.from({ length: count }, (_unused, index) => {
      const id = String(index).padStart(3, '0');
      const terminalAt = new Date(terminalBase + index * 60_000).toISOString();
      return testEnv.DB.prepare(`
        INSERT INTO event_cover_publish_receipts (
          event_id, operation_id, request_sha256, action, expected_revision, status,
          workflow_instance_id, dependency_versions_json, dispatch_state,
          dispatch_generation, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, 'publish', 0, 'applied', ?, '{}', 'confirmed', 1, ?, ?, ?)
      `).bind(
        access.event.id, `bounded-owner-${id}`, HEX, `bounded-instance-${id}`,
        terminalAt, terminalAt, new Date(base + index * 60_000).toISOString(),
      );
    });
    const fences = Array.from({ length: count }, (_unused, index) => {
      const id = String(index).padStart(3, '0');
      return testEnv.DB.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        ) VALUES ('COVER_RENDER_WORKFLOW', ?, ?, 1, 'open', ?, ?, ?)
      `).bind(
        `bounded-instance-${id}`, access.event.id, '2026-05-01T00:00:00.000Z', PAST,
        new Date(base + (count - index) * 60_000).toISOString(),
      );
    });
    await testEnv.DB.batch(receipts);
    await testEnv.DB.batch(fences);

    const firstUpgrade = await cleanupEventCovers(testEnv, NOW);
    expect(firstUpgrade).toMatchObject({ fencesDeleted: 0, receiptsExpired: 0, remainder: true });
    expect(await countRows('event_cover_workflow_fences', access.event.id)).toBe(count);
    expect(await countRows('event_cover_publish_receipts', access.event.id)).toBe(count);

    const finalUpgrade = await cleanupEventCovers(testEnv, NOW);
    expect(finalUpgrade).toMatchObject({ fencesDeleted: 0, receiptsExpired: 0, remainder: true });

    const firstSweep = await cleanupEventCovers(testEnv, NOW);

    expect(firstSweep).toMatchObject({
      receiptsExpired: COVER_CLEANUP_ROWS_PER_CLASS,
      fencesDeleted: COVER_CLEANUP_ROWS_PER_CLASS,
    });
    const pairedRemainder = await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_workflow_fences f
      JOIN event_cover_publish_receipts r
        ON r.event_id = f.event_id AND r.workflow_instance_id = f.workflow_instance_id
       AND r.dispatch_generation = f.dispatch_generation
    `).first<{ count: number }>();
    expect(pairedRemainder).toEqual({ count: 1 });

    await cleanupEventCovers(testEnv, NOW);
    expect(await countRows('event_cover_workflow_fences', access.event.id)).toBe(0);
    expect(await countRows('event_cover_publish_receipts', access.event.id)).toBe(0);
  });

  it('retains unmarked completed-purge fences for operator diagnosis', async () => {
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_rate_events (
        id, event_id, action, replay_key, request_sha256, window_start, created_at, expires_at
      ) VALUES ('rate-due', ?, 'publication', 'replay-a', ?, 1785196800, ?, ?),
               ('rate-live', ?, 'publication', 'replay-b', ?, 1785196800, ?, ?)
    `).bind(access.event.id, HEX, PAST, PAST, access.event.id, HEX, PAST, FUTURE).run();
    await insertFence('COVER_RENDER_WORKFLOW', 'purge-terminal-malformed', {
      state: 'deletion-blocked', eventId: 'retired-event',
    });
    await insertFence('COVER_RENDER_WORKFLOW', 'purge-terminal-exact-unsafe', {
      state: 'deletion-blocked', eventId: 'retired-event',
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET updated_at = CASE workflow_instance_id
        WHEN 'purge-terminal-malformed' THEN 'legacy-invalid'
        ELSE '2026-08-01T00:00:00.000Z'
      END
      WHERE workflow_instance_id IN (
        'purge-terminal-malformed', 'purge-terminal-exact-unsafe'
      )
    `).run();
    await insertFence('COVER_RENDER_WORKFLOW', 'ownerless-open');
    await insertFence('COVER_BACKFILL_WORKFLOW', 'instance-live', { expiresAt: FUTURE });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary).toMatchObject({ rateEventsDeleted: 1, fencesDeleted: 0 });
    expect(await countRows('event_cover_rate_events', access.event.id)).toBe(1);
    const remaining = await testEnv.DB.prepare(`
      SELECT workflow_instance_id FROM event_cover_workflow_fences ORDER BY workflow_instance_id
    `).all<{ workflow_instance_id: string }>();
    expect(remaining.results.map((row) => row.workflow_instance_id))
      .toEqual([
        'instance-live',
        'ownerless-open',
        'purge-terminal-exact-unsafe',
        'purge-terminal-malformed',
      ]);

    const expired = await cleanupEventCovers(
      testEnv, new Date('2026-10-10T12:00:00.000Z'),
    );
    expect(expired.fencesDeleted).toBe(0);
    expect(await fenceRow('purge-terminal-exact-unsafe')).not.toBeNull();
    expect(await fenceRow('purge-terminal-malformed')).not.toBeNull();
  });

  it('abandons an orphaned staging set but never the one the event points at', async () => {
    await insertMaster('master-orphan');
    await insertSet('set-orphan', { state: 'staging', masterId: 'master-orphan' });
    await insertSet('set-current', { state: 'active', masterId: 'master-orphan' });
    await pointEventToUpload('set-current', 'master-orphan');

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.setsAbandoned).toBe(1);
    // Discovery and deletion are different passes: the orphan gets the same
    // seven-day recovery window a retired set gets, so noticing it today does
    // not sweep it today.
    expect(summary.setsDeleted).toBe(0);
    expect(await testEnv.DB.prepare('SELECT state FROM event_cover_render_sets WHERE id = ?')
      .bind('set-orphan').first()).toEqual({ state: 'abandoned' });
    expect(await testEnv.DB.prepare('SELECT state FROM event_cover_render_sets WHERE id = ?')
      .bind('set-current').first()).toEqual({ state: 'active' });
  });

  it('leaves a staging set alone while a receipt or a job still owns it', async () => {
    await insertMaster('master-owned');
    await insertSet('set-owned', { state: 'staging', masterId: 'master-owned' });
    await insertReceipt('op-owner', { status: 'rendering', expiresAt: FUTURE, setId: 'set-owned' });

    expect((await cleanupEventCovers(testEnv, NOW)).setsAbandoned).toBe(0);
    expect(await testEnv.DB.prepare('SELECT state FROM event_cover_render_sets WHERE id = ?')
      .bind('set-owned').first()).toEqual({ state: 'staging' });
  });

  it('deletes every render object before its set, and keeps a set it could not finish', async () => {
    await insertMaster('master-set');
    await insertSet('set-collectable', {
      state: 'retired', masterId: 'master-set', cleanupAfter: PAST,
    });
    const first = await insertRenderObject('object-a', 'set-collectable', 'wide-expanded');
    const second = await insertRenderObject('object-b', 'set-collectable', 'short-lookup');

    const failing = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete')
      .mockRejectedValueOnce(new Error('R2 unavailable'));
    const partial = await cleanupEventCovers(testEnv, NOW);
    failing.mockRestore();

    expect(partial.renderObjectsDeleted).toBe(1);
    expect(partial.setsDeleted).toBe(0);
    // The set survives because one of its objects is still in the bucket, and the
    // row is the only record that the object is there at all.
    expect(await countRows('event_cover_render_sets', access.event.id)).toBe(1);

    const complete = await cleanupEventCovers(testEnv, NOW);
    expect(complete.setsDeleted).toBe(1);
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(false);
    expect(await countRows('event_cover_render_objects', access.event.id)).toBe(0);
  });

  it('keeps a displaced normalized set and master in R2 until their shared retention deadline', async () => {
    const masterKey = await insertMaster('master-retained', { cleanupAfter: FUTURE });
    await insertSet('set-retained', {
      state: 'retired', masterId: 'master-retained', cleanupAfter: FUTURE,
    });
    const renderedKey = await insertRenderObject(
      'object-retained', 'set-retained', 'wide-expanded',
    );

    const early = await cleanupEventCovers(testEnv, NOW);
    expect(early).toMatchObject({ renderObjectsDeleted: 0, setsDeleted: 0, mastersDeleted: 0 });
    expect(await exists(renderedKey)).toBe(true);
    expect(await exists(masterKey)).toBe(true);

    const due = await cleanupEventCovers(testEnv, new Date(FUTURE));
    expect(due).toMatchObject({ renderObjectsDeleted: 1, setsDeleted: 1, mastersDeleted: 1 });
    expect(await exists(renderedKey)).toBe(false);
    expect(await exists(masterKey)).toBe(false);
    expect(await countRows('event_cover_render_sets', access.event.id)).toBe(0);
    expect(await countRows('event_cover_masters', access.event.id)).toBe(0);
  });

  it('deletes a retired legacy original but never the key the event still serves', async () => {
    const displaced = await put(`${prefix()}/legacy-old.jpg`);
    const current = await insertMaster('master-current');
    await insertSet('set-current', { state: 'active', masterId: 'master-current' });
    await pointEventToUpload('set-current', 'master-current');
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_retired_legacy_objects (
        id, event_id, object_key, key_fingerprint, reason, retired_at, cleanup_after
      ) VALUES ('retired-old', ?, ?, ?, 'replaced', ?, ?),
               ('retired-current', ?, ?, ?, 'backfilled', ?, ?)
    `).bind(
      access.event.id, displaced, HEX, PAST, PAST,
      access.event.id, current, HEX, PAST, PAST,
    ).run();

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.legacyObjectsDeleted).toBe(1);
    expect(await exists(displaced)).toBe(false);
    // An inventory row that disagrees with the event pointer is never acted on.
    expect(await exists(current)).toBe(true);
    expect(await countRows('event_cover_retired_legacy_objects', access.event.id)).toBe(1);
  });

  it('deletes a master last, nulling only the pointer of a draft that is over', async () => {
    const key = await insertMaster('master-collectable', { cleanupAfter: PAST });
    await insertDraft('draft-terminal', { state: 'expired', masterId: 'master-collectable' });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.mastersDeleted).toBe(1);
    expect(await exists(key)).toBe(false);
    expect(await countRows('event_cover_masters', access.event.id)).toBe(0);
    expect(await testEnv.DB.prepare('SELECT master_id FROM event_cover_drafts WHERE id = ?')
      .bind('draft-terminal').first()).toEqual({ master_id: null });
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it.each([
    ['a live draft', async () => {
      await insertDraft('draft-live', { state: 'ready', expiresAt: FUTURE, masterId: 'master-kept' });
    }],
    ['a render set', async () => {
      await insertSet('set-kept', { state: 'active', masterId: 'master-kept' });
    }],
    ['a backfill job', async () => {
      await insertBackfillJob('job-kept', 'run-kept', { status: 'applied', masterId: 'master-kept' });
    }],
  ])('keeps a master %s still references', async (_name, seed) => {
    const key = await insertMaster('master-kept', { cleanupAfter: PAST });
    await seed();

    expect((await cleanupEventCovers(testEnv, NOW)).mastersDeleted).toBe(0);
    expect(await exists(key)).toBe(true);
    expect(await countRows('event_cover_masters', access.event.id)).toBe(1);
  });

  it('keeps the master the event still points at, however old its cleanup deadline', async () => {
    const key = await insertMaster('master-active', { cleanupAfter: PAST });
    await insertSet('set-active', { state: 'active', masterId: 'master-active' });
    await pointEventToUpload('set-active', 'master-active');

    expect((await cleanupEventCovers(testEnv, NOW)).mastersDeleted).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('reports a remainder when a class fills its per-pass bound', async () => {
    const statements = Array.from({ length: COVER_CLEANUP_ROWS_PER_CLASS + 5 }, (_unused, index) => (
      testEnv.DB.prepare(`
        INSERT INTO event_cover_rate_events (
          id, event_id, action, replay_key, request_sha256, window_start, created_at, expires_at
        ) VALUES (?, ?, 'reservation', ?, ?, 1785196800, ?, ?)
      `).bind(`rate-${index}`, access.event.id, `replay-${index}`, HEX, PAST, PAST)
    ));
    await testEnv.DB.batch(statements);

    const first = await cleanupEventCovers(testEnv, NOW);
    expect(first.rateEventsDeleted).toBe(COVER_CLEANUP_ROWS_PER_CLASS);
    expect(first.remainder).toBe(true);

    const second = await cleanupEventCovers(testEnv, NOW);
    expect(second.rateEventsDeleted).toBe(5);
    expect(second.remainder).toBe(false);
    expect(await countRows('event_cover_rate_events', access.event.id)).toBe(0);
  });

  it('deletes only expired closed empty runs and keeps an active run even with a bad deadline', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at, expires_at)
        VALUES ('active-expired-run', 'execute', 'executing', ?, ?, ?)
      `).bind(PAST, PAST, PAST),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at, expires_at)
        VALUES ('verified-expired-run', 'verify', 'verified', ?, ?, ?)
      `).bind(PAST, PAST, PAST),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at, expires_at)
        VALUES ('failed-expired-run', 'execute', 'failed', ?, ?, ?)
      `).bind(PAST, PAST, PAST),
    ]);

    await cleanupEventCovers(testEnv, NOW);

    expect((await testEnv.DB.prepare(`
      SELECT id, status FROM event_cover_backfill_runs ORDER BY id
    `).all()).results).toEqual([{ id: 'active-expired-run', status: 'executing' }]);
  });

  it('deletes an expired terminal job but retains an equivalently expired nonterminal job', async () => {
    await insertBackfillJob('expired-terminal-job', 'expired-terminal-run', {
      status: 'applied', expiresAt: PAST,
    });
    await insertBackfillJob('expired-live-job', 'expired-live-run', {
      status: 'queued', expiresAt: PAST,
    });
    await insertBackfillJob('expired-failed-inside-job', 'expired-failed-inside-run', {
      status: 'failed', retryable: 1, terminalAt: '2026-08-09T12:00:00.001Z', expiresAt: PAST,
    });
    await insertBackfillJob('expired-failed-null-job', 'expired-failed-null-run', {
      status: 'failed', retryable: 1, terminalAt: null, expiresAt: PAST,
    });
    await insertBackfillJob('expired-failed-boundary-job', 'expired-failed-boundary-run', {
      status: 'failed', retryable: 1, terminalAt: '2026-08-09T12:00:00.000Z', expiresAt: PAST,
    });
    await insertBackfillJob('expired-failed-permanent-job', 'expired-failed-permanent-run', {
      status: 'failed', retryable: 0, terminalAt: null, expiresAt: PAST,
    });

    await cleanupEventCovers(testEnv, NOW);

    expect((await testEnv.DB.prepare(`
      SELECT id, status FROM event_cover_backfill_jobs
      WHERE id LIKE 'expired-%-job' ORDER BY id
    `).all()).results).toEqual([
      { id: 'expired-failed-inside-job', status: 'failed' },
      { id: 'expired-failed-null-job', status: 'failed' },
      { id: 'expired-live-job', status: 'queued' },
    ]);
  });

  it('bounds expired closed-run cleanup by expiry and ID and reports saturation', async () => {
    const statements = Array.from({ length: COVER_CLEANUP_ROWS_PER_CLASS + 1 }, (_unused, index) => (
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at, expires_at)
        VALUES (?, 'verify', 'verified', ?, ?, ?)
      `).bind(`expired-run-${index.toString().padStart(3, '0')}`, PAST, PAST, PAST)
    ));
    for (let offset = 0; offset < statements.length; offset += 100) {
      await testEnv.DB.batch(statements.slice(offset, offset + 100));
    }

    expect((await cleanupEventCovers(testEnv, NOW)).remainder).toBe(true);
    expect((await testEnv.DB.prepare(`
      SELECT id FROM event_cover_backfill_runs WHERE id LIKE 'expired-run-%' ORDER BY id
    `).all()).results).toEqual([{ id: 'expired-run-100' }]);
    expect((await cleanupEventCovers(testEnv, NOW)).remainder).toBe(false);
  });

  it('runs resolver, stale-create recovery, reconciliation, cover cleanup, then purge', async () => {
    const phases: string[] = [];
    const note = (phase: string) => {
      if (!phases.includes(phase)) phases.push(phase);
    };
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('AS event_exists')
              && sql.includes("j.status IN ('needs_replacement', 'failed')")) note('resolver');
            if (sql.includes("j.dispatch_state = 'creating'")
              && sql.includes('fence_state')) note('stale-create recovery');
            if (sql.includes("j.dispatch_state = 'confirmed'")
              && sql.includes('event_deleted_at')) note('reconciliation');
            if (sql.includes('SELECT r.id FROM event_cover_backfill_runs r')
              && sql.includes('inventory_sha256')) note('run closure');
            if (sql.includes('WITH terminal_owners AS')) note('cover cleanup');
            if (sql.includes('LEFT JOIN event_cover_purge_progress p')
              && sql.includes('SELECT e.id FROM events e')) note('purge');
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await scheduledCleanup({ ...testEnv, DB: db }, NOW);

    expect(phases).toEqual([
      'resolver', 'stale-create recovery', 'reconciliation', 'run closure', 'cover cleanup', 'purge',
    ]);
  });

  it('continues cover cleanup and purge when the global resolver reports a remainder', async () => {
    for (let index = 0; index < COVER_CLEANUP_ROWS_PER_CLASS; index += 1) {
      await insertBackfillJob(`schedule-job-${index}`, `schedule-run-${index}`, {
        status: 'needs_replacement',
      });
    }
    await insertBackfillJob('schedule-stale-create', 'schedule-stale-create-run', {
      status: 'queued',
    });
    await testEnv.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET dispatch_state = 'creating', terminal_at = NULL WHERE id = 'schedule-stale-create'
    `).run();
    await insertFence('COVER_BACKFILL_WORKFLOW', 'backfill-schedule-stale-create', {
      state: 'deletion-blocked',
    });
    await insertBackfillJob('schedule-reconcile', 'schedule-reconcile-run', {
      status: 'rendering',
    });
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_rate_events (
        id, event_id, action, replay_key, request_sha256, window_start, created_at, expires_at
      ) VALUES ('schedule-rate', ?, 'reservation', 'schedule-replay', ?, 1785196800, ?, ?)
    `).bind(access.event.id, HEX, PAST, PAST).run();
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
      VALUES ('schedule-close', 'verify', 'executing', ?, ?)
    `).bind(PAST, PAST).run();
    const due = await eventAccess('Due after saturated resolver');
    await testEnv.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind(PAST, due.event.id).run();

    await scheduledCleanup(testEnv, NOW);

    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_backfill_jobs
      WHERE id LIKE 'schedule-job-%' AND status = 'resolved'
    `).first<{ count: number }>()).toEqual({ count: COVER_CLEANUP_ROWS_PER_CLASS });
    expect(await testEnv.DB.prepare(`
      SELECT id, status, dispatch_state, failure_code FROM event_cover_backfill_jobs
      WHERE id IN ('schedule-stale-create', 'schedule-reconcile') ORDER BY id
    `).all()).toMatchObject({
      results: [
        {
          id: 'schedule-reconcile', status: 'failed', dispatch_state: 'blocked',
          failure_code: 'EVENT_DELETED',
        },
        {
          id: 'schedule-stale-create', status: 'failed', dispatch_state: 'blocked',
          failure_code: 'EVENT_DELETED',
        },
      ],
    });
    expect(await countRows('event_cover_rate_events', access.event.id)).toBe(0);
    expect(await testEnv.DB.prepare(`
      SELECT status, verified_at, expires_at FROM event_cover_backfill_runs
      WHERE id = 'schedule-close'
    `).first()).toMatchObject({ status: 'verified', verified_at: NOW.toISOString() });
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(due.event.id).first()).toBeNull();
  });

  it('exposes the bounded deleted-event purge phase independently', async () => {
    const due = await eventAccess('Explicit purge phase');
    await testEnv.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind(PAST, due.event.id).run();

    expect(await resumeDeletedEventPurges(testEnv, NOW)).toBe(1);
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(due.event.id).first()).toBeNull();
  });

  it('runs inside the scheduled pass, ahead of the retention purge', async () => {
    await insertReceipt('op-swept', { status: 'applied', expiresAt: PAST });
    const other = await eventAccess('Nadia & Sam');
    await seedEventCoverGraph(testEnv.DB, other.event.id);
    await testEnv.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind(PAST, other.event.id).run();

    await scheduledCleanup(testEnv, NOW);

    // The sweep ran, and the purge that follows it still completed against an
    // event owning a row in every cover table.
    expect(await countRows('event_cover_publish_receipts', access.event.id)).toBe(0);
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(other.event.id).first()).toBeNull();
    expect(await foreignKeyCheck()).toEqual([]);
  });

  /**
   * Reconciliation is wired between initial-create recovery and the purge.
   *
   * Proved with the one branch that needs no platform call: a job the ledger
   * believes is running whose fence has gone. A missing retained fence is
   * terminal deletion evidence, so seeing the job settle as EVENT_DELETED is
   * proof reconciliation ran — and the assertion cannot drift onto whatever a
   * test binding happens to report for an instance that was never really created.
   */
  it('reconciles the backfill ledger inside the scheduled pass', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
        VALUES ('run-reconciled', 'execute', 'executing', ?, ?)
      `).bind(PAST, PAST),
      testEnv.DB.prepare(`
        INSERT INTO event_cover_backfill_jobs (
          id, run_id, event_id, expected_revision, legacy_key_fingerprint,
          workflow_instance_id, dispatch_state, dispatch_generation, status,
          dependency_versions_json, created_at, updated_at
        ) VALUES ('job-reconciled', 'run-reconciled', ?, 0, ?, 'instance-reconciled',
          'confirmed', 1, 'rendering', '{"normalizationLadder":1}', ?, ?)
      `).bind(access.event.id, HEX, PAST, PAST),
    ]);

    await scheduledCleanup(testEnv, NOW);

    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, failure_code, retryable
      FROM event_cover_backfill_jobs WHERE id = 'job-reconciled'
    `).first()).toEqual({
      status: 'failed', dispatch_state: 'blocked',
      failure_code: 'EVENT_DELETED', retryable: 0,
    });
    expect(await foreignKeyCheck()).toEqual([]);
  });
});

describe('album-share session cleanup', () => {
  beforeEach(resetDatabase);

  it('deletes at most one bounded page of expired sessions per scheduled pass', async () => {
    const cleanupNow = new Date('2026-08-23T12:00:00.000Z');
    const expiredAt = '2026-08-20T00:00:00.000Z';
    const futureAt = '2026-08-25T00:00:00.000Z';
    const access = await eventAccess('Album session cleanup');
    const shareId = crypto.randomUUID();
    await testEnv.DB.prepare(`
      INSERT INTO event_album_shares (
        id, event_id, secret_digest, secret_ciphertext, shared_at, created_at
      ) VALUES (?, ?, 'share-digest', 'v1.iv.ciphertext', ?, ?)
    `).bind(shareId, access.event.id, expiredAt, expiredAt).run();

    const sessions = Array.from({ length: 102 }, (_, index) => testEnv.DB.prepare(`
      INSERT INTO event_album_share_sessions (
        id, share_id, event_id, secret_digest, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      `expired-album-session-${index.toString().padStart(3, '0')}`,
      shareId,
      access.event.id,
      `digest-${index}`,
      index === 101 ? futureAt : expiredAt,
      expiredAt,
    ));
    await batchD1Statements(testEnv.DB, sessions);

    await scheduledCleanup(testEnv, cleanupNow);

    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_album_share_sessions WHERE expires_at <= ?
    `).bind(cleanupNow.toISOString()).first<number>('count')).toBe(1);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_album_share_sessions WHERE expires_at > ?
    `).bind(cleanupNow.toISOString()).first<number>('count')).toBe(1);
  });
});

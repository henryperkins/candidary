import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_COVER_PUBLICATIONS_PER_HOUR,
  MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT,
  MAX_RETAINED_COVER_RECEIPTS_PER_EVENT,
} from '../../shared/constants';
import {
  EVENT_COVER_PROFILES,
  type EventCoverPublishRequestV1,
} from '../../shared/event-cover';
import { createCoverDraft, insertCoverMaster } from '../../worker/db/event-covers';
import { EventsRepository } from '../../worker/db/events';
import type { EventRecord } from '../../worker/db/types';
import type { AppEnv } from '../../worker/env';
import {
  acceptCoverPublication,
  applyRemovalPublication,
  applySemanticCoverPublication,
  claimInitialCoverDispatch,
  confirmCoverDispatch,
  coverWorkflowInstanceId,
  markDispatchFailed,
  readCoverPublication,
  restartCoverPublication,
  selectEventCoverPreparation,
} from '../../worker/services/event-cover-publication';
import { coverMasterKey } from '../../worker/storage/event-cover-keys';
import {
  COVER_PLATFORM_STATUSES,
  classifyInstanceStatus,
  classifyWorkflowLookupError,
  defaultCoverBackfillWorkflowAccessor,
  dispositionForLookup,
  isCertifiedWorkflowNotFound,
  mapPlatformStatus,
  type CoverPlatformStatus,
  type CoverWorkflowAccessor,
  type CoverWorkflowLookup,
} from '../../worker/workflows/cover-platform';
import { eventAccess, migrationsUpTo, resetDatabase, testEnv } from './helpers';

const now = new Date('2026-08-04T12:00:00.000Z');
const HEX_64 = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);
const OPERATION = '5f3a2b18-6c2d-4f0e-9a71-0c2d1e8b4a55';
const COMPETING_PRESET_CONFIG = JSON.stringify({
  version: 1,
  source: { kind: 'preset', presetId: 'pressed-paper', assetVersion: 1 },
  effect: 'natural',
});

type Access = Awaited<ReturnType<typeof eventAccess>>;

function competingPresetStatement(eventId: string): D1PreparedStatement {
  return testEnv.DB.prepare(`
    UPDATE events
    SET cover_config = ?, cover_object_key = NULL, cover_render_set_id = NULL,
        cover_revision = cover_revision + 1
    WHERE id = ?
  `).bind(COMPETING_PRESET_CONFIG, eventId);
}

async function moveEventToCompetingPreset(eventId: string): Promise<void> {
  await competingPresetStatement(eventId).run();
}

/**
 * Records every lifecycle call, because none of them has a precedent locally.
 *
 * Takes a `CoverWorkflowLookup` rather than a status string: absence is a
 * classification the adapter produces, not a value the platform can return, so
 * a fake that accepted `'not-found'` as a status would model something that
 * cannot happen.
 */
function fakeWorkflow(
  outcome: CoverWorkflowLookup | CoverPlatformStatus = 'running',
  failures: Partial<Record<string, boolean>> = {},
) {
  const lookup: CoverWorkflowLookup = typeof outcome === 'string'
    ? { kind: 'status', status: outcome }
    : outcome;
  const calls: string[] = [];
  const accessor: CoverWorkflowAccessor = {
    async create(id) { calls.push(`create:${id}`); if (failures.create) throw new Error('dispatch'); },
    async lookup() { calls.push('lookup'); return lookup; },
    async resume(id) { calls.push(`resume:${id}`); if (failures.resume) throw new Error('resume'); },
    async restart(id) { calls.push(`restart:${id}`); if (failures.restart) throw new Error('restart'); },
    async terminate(id) { calls.push(`terminate:${id}`); },
  };
  return { accessor, calls };
}

function rejectingRestartWorkflow(
  afterFailure: CoverWorkflowLookup,
  onRestart: () => Promise<void> = async () => {},
) {
  let lookups = 0;
  const calls: string[] = [];
  const accessor: CoverWorkflowAccessor = {
    async create(id) { calls.push(`create:${id}`); },
    async lookup() {
      calls.push('lookup');
      lookups += 1;
      return lookups === 1 ? { kind: 'status', status: 'errored' } : afterFailure;
    },
    async resume(id) { calls.push(`resume:${id}`); },
    async restart(id) {
      calls.push(`restart:${id}`);
      await onRestart();
      throw new Error('restart unavailable');
    },
    async terminate(id) { calls.push(`terminate:${id}`); },
  };
  return { accessor, calls };
}

async function reload(eventId: string): Promise<EventRecord> {
  return (await new EventsRepository(testEnv.DB).getById(eventId))!;
}

async function readyDraft(access: Access, intent = 'intent-a') {
  const masterId = `master-${intent}`;
  await insertCoverMaster(testEnv.DB, {
    id: masterId,
    eventId: access.event.id,
    objectKey: coverMasterKey(access.event.id, masterId),
    byteSize: 900_000, width: 2480, height: 1680, sha256: HEX_64,
    normalizationVersion: 1, normalizationRung: 1, now,
  });
  const created = await createCoverDraft(testEnv.DB, {
    eventId: access.event.id, draftIntentId: intent, requestDigest: HEX_64,
    source: 'existing_upload', masterId, now,
  });
  return created.draft;
}

function uploadRequest(draftId: string, patch: Partial<EventCoverPublishRequestV1> = {}) {
  return {
    operationId: OPERATION,
    expectedRevision: 0,
    source: { kind: 'upload', draftId },
    focus: { mode: 'auto' },
    effect: 'natural',
    ...patch,
  } as EventCoverPublishRequestV1;
}

function presetRequest(patch: Partial<EventCoverPublishRequestV1> = {}): EventCoverPublishRequestV1 {
  return {
    operationId: OPERATION,
    expectedRevision: 0,
    source: { kind: 'preset', presetId: 'warm-linen' },
    effect: 'film',
    ...patch,
  } as EventCoverPublishRequestV1;
}

function noneRequest(patch: Partial<EventCoverPublishRequestV1> = {}): EventCoverPublishRequestV1 {
  return {
    operationId: OPERATION,
    expectedRevision: 0,
    source: { kind: 'none' },
    ...patch,
  } as EventCoverPublishRequestV1;
}

async function seedActiveUploadCover(
  access: Access,
  options: { receiptExpiry?: string } = {},
) {
  const masterId = 'master-active';
  const setId = 'set-active';
  const objectKey = coverMasterKey(access.event.id, masterId);
  const timestamp = now.toISOString();
  await insertCoverMaster(testEnv.DB, {
    id: masterId,
    eventId: access.event.id,
    objectKey,
    byteSize: 900_000,
    width: 2480,
    height: 1680,
    sha256: HEX_64,
    normalizationVersion: 1,
    normalizationRung: 1,
    now,
  });
  await testEnv.MEDIA_BUCKET.put(objectKey, new Uint8Array([4, 5, 6]));
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_render_sets (
      id, event_id, master_id, recipe_json, recipe_sha256, state,
      required_slots, created_at
    ) VALUES (?, ?, ?, ?, ?, 'staging', 12, ?)
  `).bind(
    setId,
    access.event.id,
    masterId,
    '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
    HEX_64,
    timestamp,
  ).run();
  await testEnv.DB.batch(EVENT_COVER_PROFILES.flatMap((profile) => (
    ['webp', 'jpeg'] as const
  ).map((format) => testEnv.DB.prepare(`
    INSERT INTO event_cover_render_objects (
      id, render_set_id, event_id, profile_id, density, format, object_key,
      content_type, byte_size, width, height, quality_rung, sha256, created_at
    ) VALUES (?, ?, ?, ?, '1x', ?, ?, ?, 100, ?, ?, 1, ?, ?)
  `).bind(
    `${setId}-${profile.id}-${format}`,
    setId,
    access.event.id,
    profile.id,
    format,
    `events/${access.event.id}/cover/rendered/${setId}/${profile.id}-1x.${format}`,
    format === 'webp' ? 'image/webp' : 'image/jpeg',
    profile.width,
    profile.height,
    HEX_64,
    timestamp,
  ))));
  await testEnv.DB.prepare(`
    UPDATE event_cover_render_sets
    SET state = 'active', manifest_sha256 = ?, published_revision = 1,
        ready_at = ?, published_at = ?
    WHERE id = ?
  `).bind(OTHER_HEX, timestamp, timestamp, setId).run();
  await testEnv.DB.prepare(`
    UPDATE events SET
      cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
    WHERE id = ?
  `).bind(
    '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
    objectKey,
    setId,
    access.event.id,
  ).run();
  if (options.receiptExpiry) {
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (
        event_id, operation_id, render_set_id, request_sha256, action,
        expected_revision, status, dependency_versions_json, completed_profiles,
        required_profiles, applied_revision, result_cover_json, retryable,
        dispatch_state, dispatch_generation, created_at, updated_at, expires_at
      ) VALUES (?, 'old-upload-operation', ?, ?, 'publish', 0, 'applied', '{}',
        6, 6, 1, ?, 0, 'confirmed', 0, ?, ?, ?)
    `).bind(
      access.event.id,
      setId,
      OTHER_HEX,
      '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
      timestamp,
      timestamp,
      options.receiptExpiry,
    ).run();
  }
  return { masterId, setId, objectKey };
}

async function completeRenderSet(eventId: string, setId: string): Promise<void> {
  const set = await testEnv.DB.prepare(`
    SELECT required_slots FROM event_cover_render_sets WHERE id = ? AND event_id = ?
  `).bind(setId, eventId).first<{ required_slots: number }>();
  if (!set) throw new Error('Expected render-set fixture.');
  const densities = set.required_slots === 24 ? ['1x', '2x'] as const : ['1x'] as const;
  await testEnv.DB.batch(EVENT_COVER_PROFILES.flatMap((profile) => densities.flatMap((density) => (
    ['webp', 'jpeg'] as const
  ).map((format) => testEnv.DB.prepare(`
    INSERT OR IGNORE INTO event_cover_render_objects (
      id, render_set_id, event_id, profile_id, density, format, object_key,
      content_type, byte_size, width, height, quality_rung, sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, ?, ?, 1, ?, ?)
  `).bind(
    `${setId}-${profile.id}-${density}-${format}`,
    setId,
    eventId,
    profile.id,
    density,
    format,
    `events/${eventId}/cover/rendered/${setId}/${profile.id}-${density}.${format}`,
    format === 'webp' ? 'image/webp' : 'image/jpeg',
    profile.width * (density === '2x' ? 2 : 1),
    profile.height * (density === '2x' ? 2 : 1),
    HEX_64,
    now.toISOString(),
  )))));
  await testEnv.DB.prepare(`
    UPDATE event_cover_render_sets
    SET state = 'ready', manifest_sha256 = ?, ready_at = ?
    WHERE id = ? AND event_id = ?
  `).bind(HEX_64, now.toISOString(), setId, eventId).run();
}

async function applySemanticForTest(
  access: Access,
  request: EventCoverPublishRequestV1,
  requestDigest = HEX_64,
  env: AppEnv = testEnv,
) {
  return applySemanticCoverPublication(env, {
    event: await reload(access.event.id),
    request,
    requestDigest,
    now,
  });
}

function zeroSemanticTailDb(fragment: string) {
  let injected = false;
  const db = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (!injected && sql.includes(fragment)) {
            injected = true;
            // Preserve the production statement and every one of its bindings;
            // only make the final predicate false so D1 executes it normally
            // and reports zero changed rows instead of a bind-count error.
            return target.prepare(`${sql}\nAND 0`);
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, wasInjected: () => injected };
}

async function draftState(id: string): Promise<string> {
  const row = await testEnv.DB.prepare('SELECT state FROM event_cover_drafts WHERE id = ?')
    .bind(id).first<{ state: string }>();
  return row!.state;
}

async function seedRetainedReceipts(eventId: string, count: number, prefix: string): Promise<void> {
  await testEnv.DB.prepare(`
    WITH digits(d) AS (
      VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
    ), sequence(n) AS (
      SELECT ones.d + (10 * tens.d) + (100 * hundreds.d) + (1000 * thousands.d) + 1
      FROM digits ones CROSS JOIN digits tens CROSS JOIN digits hundreds CROSS JOIN digits thousands
    )
    INSERT INTO event_cover_publish_receipts (
      event_id, operation_id, request_sha256, action, expected_revision, status,
      dependency_versions_json, completed_profiles, required_profiles, retryable,
      dispatch_state, dispatch_generation, created_at, updated_at, expires_at
    )
    SELECT ?, printf('%s-%04d', ?, n), ?, 'remove', 0, 'conflict', '{}', 0, 0, 0,
      'pending', 0, ?, ?, ?
    FROM sequence WHERE n <= ?
  `).bind(
    eventId, prefix, HEX_64,
    now.toISOString(), now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString(),
    count,
  ).run();
}

async function seedNonactiveRenderSets(eventId: string, count: number): Promise<void> {
  await testEnv.DB.prepare(`
    WITH RECURSIVE sequence(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
    )
    INSERT INTO event_cover_render_sets (
      id, event_id, master_id, draft_id, recipe_json, recipe_sha256,
      state, required_slots, created_at, abandoned_reason, abandoned_at
    )
    SELECT printf('cap-set-%04d', sequence.n), owned.event_id, owned.master_id, owned.draft_id,
      owned.recipe_json, owned.recipe_sha256, 'abandoned', owned.required_slots,
      owned.created_at, 'test-cap', owned.created_at
    FROM sequence
    JOIN event_cover_render_sets owned ON owned.id = (
      SELECT render_set_id FROM event_cover_publish_receipts
      WHERE event_id = ? AND operation_id = ?
    )
  `).bind(count, eventId, OPERATION).run();
}

describe('platform status map', () => {
  it('names exactly the documented binding union, which has no absence member', () => {
    expect([...COVER_PLATFORM_STATUSES]).toEqual([
      'queued', 'running', 'paused', 'errored', 'terminated',
      'complete', 'waiting', 'waitingForPause', 'unknown',
    ]);
    // Absence is a lookup *result*, never a status the platform can report.
    expect([...COVER_PLATFORM_STATUSES]).not.toContain('not-found');
    expect([...COVER_PLATFORM_STATUSES]).not.toContain('missing');
  });

  it('is total, and only the named values are ever treated as non-running', () => {
    for (const status of ['queued', 'running', 'waiting', 'waitingForPause']) {
      expect(mapPlatformStatus(status)).toMatchObject({
        kind: 'active', productStatus: 'preparing', mutates: false,
      });
    }
    // Paused resumes on the same instance; restarting would discard valid steps.
    expect(mapPlatformStatus('paused')).toMatchObject({ recovery: 'resume', mutates: true });
    expect(mapPlatformStatus('errored')).toMatchObject({ recovery: 'restart', mutates: true });
    expect(mapPlatformStatus('terminated')).toMatchObject({ recovery: 'restart', mutates: true });
    expect(mapPlatformStatus('complete')).toMatchObject({ kind: 'complete', mutates: true });
    // Absence of information is never evidence of absence of work.
    expect(mapPlatformStatus('unknown')).toMatchObject({
      kind: 'unknown', mutates: false, productStatus: 'preparing',
    });

    // The preserving default: an unrecognized value keeps product state and
    // reports itself rather than being guessed at.
    const unmapped = mapPlatformStatus('someFutureState');
    expect(unmapped).toMatchObject({ kind: 'active', mutates: false, productStatus: 'preparing' });
    expect(unmapped.telemetry).toBe('cover_platform_unmapped');
  });

  it('refuses to derive absence from any status string', () => {
    // Phase 1 mapped this literal to `missing`, but the platform never emits it.
    // It must now fall to the preserving default like any other unknown value,
    // so no code path can reach `create` by inventing a status.
    for (const invented of ['not-found', 'notFound', 'missing', 'deleted', '404']) {
      const disposition = mapPlatformStatus(invented);
      expect(disposition.kind).not.toBe('missing');
      expect(disposition.recovery).not.toBe('create');
      expect(disposition.mutates).toBe(false);
    }
  });
});

describe('workflow lookup classification', () => {
  it('reports a real status as a status', () => {
    expect(classifyInstanceStatus({ status: 'running' })).toEqual({
      kind: 'status', status: 'running',
    });
    // An unrecognized value is still a status reading, not an unknown lookup:
    // the instance answered. `mapPlatformStatus` decides what to do about it.
    expect(classifyInstanceStatus({ status: 'someFutureState' })).toMatchObject({ kind: 'status' });
  });

  it('treats a shapeless status payload as the platform `unknown` status', () => {
    expect(classifyInstanceStatus(null)).toEqual({ kind: 'status', status: 'unknown' });
    expect(classifyInstanceStatus({})).toEqual({ kind: 'status', status: 'unknown' });
  });

  it('certifies nothing as missing, because no discriminator is proven yet', () => {
    // Cloudflare documents only `e.message` and throws the same way for an
    // absent ID and an invalid one. Until Task 11 proves a stable
    // discriminator against the deployed platform, recreation stays disabled.
    const candidates: unknown[] = [
      new Error('failed to get instance cr1-abc: instance not found'),
      new Error('not found'),
      Object.assign(new Error('nope'), { code: 404, status: 404 }),
      Object.assign(new Error('nope'), { name: 'NotFoundError' }),
      { message: 'instance does not exist' },
      'instance not found',
      null,
    ];
    for (const candidate of candidates) {
      expect(isCertifiedWorkflowNotFound(candidate)).toBe(false);
      expect(classifyWorkflowLookupError(candidate).kind).toBe('unknown');
    }
  });

  it('never puts an error message or instance ID into telemetry', () => {
    // The documented failure message embeds the instance ID verbatim.
    const lookup = classifyWorkflowLookupError(
      new Error('failed to get instance cr1-deadbeefcafe: boom'),
    );
    expect(lookup.kind).toBe('unknown');
    const telemetry = lookup.kind === 'unknown' ? lookup.telemetry : '';
    expect(telemetry).not.toContain('cr1-deadbeefcafe');
    expect(telemetry).not.toContain('boom');
    expect(telemetry.length).toBeLessThanOrEqual(64);
  });

  it('gives an unknown lookup a mutation-free disposition', () => {
    const disposition = dispositionForLookup({ kind: 'unknown', telemetry: 'x' });
    expect(disposition).toMatchObject({
      kind: 'unknown', mutates: false, recovery: 'none', productStatus: 'preparing',
    });
  });

  it('gives a certified-missing lookup the create disposition', () => {
    // Unreachable in this candidate by construction, but the disposition must
    // exist and be exactly `create` for when Task 11 certifies a discriminator.
    expect(dispositionForLookup({ kind: 'missing' })).toMatchObject({
      kind: 'missing', recovery: 'create', mutates: true, retryable: true,
    });
  });

  it('routes a status lookup through the same total map', () => {
    for (const status of COVER_PLATFORM_STATUSES) {
      expect(dispositionForLookup({ kind: 'status', status }))
        .toEqual(mapPlatformStatus(status));
    }
  });
});

describe('backfill restart accessor', () => {
  it('restarts the same instance from the beginning without step options', async () => {
    const instanceId = 'cb1-0123456789abcdef';
    const gets: string[] = [];
    const restartArguments: unknown[][] = [];
    const env = {
      ...testEnv,
      COVER_BACKFILL_WORKFLOW: {
        async get(id: string) {
          gets.push(id);
          return {
            async restart(...args: unknown[]) { restartArguments.push(args); },
          };
        },
      },
    } as unknown as AppEnv;

    await defaultCoverBackfillWorkflowAccessor(env).restart(instanceId);

    expect(gets).toEqual([instanceId]);
    expect(restartArguments).toEqual([[]]);
  });
});

describe('deterministic workflow identity', () => {
  it('derives one bounded lowercase-hex ID per operation', async () => {
    const first = await coverWorkflowInstanceId('event-a', OPERATION);
    expect(first).toMatch(/^cr1-[0-9a-f]{48}$/u);
    expect(await coverWorkflowInstanceId('event-a', OPERATION)).toBe(first);
    expect(await coverWorkflowInstanceId('event-b', OPERATION)).not.toBe(first);
    expect(await coverWorkflowInstanceId('event-a', 'other-operation')).not.toBe(first);
  });
});

describe('publication acceptance', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('inserts once, freezes the draft, allocates a set, and replays identically', async () => {
    const draft = await readyDraft(access);
    const event = await reload(access.event.id);
    const first = await acceptCoverPublication(testEnv, {
      event, request: uploadRequest(draft.id), requestDigest: HEX_64, now,
    });

    expect(first.accepted).toBe(true);
    expect(first.view).toMatchObject({
      operationId: OPERATION, status: 'preparing', completedSteps: 0, requiredSteps: 6,
    });
    expect(first.receipt.workflow_instance_id).toBe(
      await coverWorkflowInstanceId(access.event.id, OPERATION),
    );
    expect(first.receipt.dispatch_state).toBe('pending');
    // `publishing` is what makes the draft non-discardable until terminal.
    expect(await draftState(draft.id)).toBe('publishing');
    const set = await testEnv.DB.prepare(
      'SELECT state, required_slots FROM event_cover_render_sets WHERE id = ?',
    ).bind(first.receipt.render_set_id).first();
    expect(set).toEqual({ state: 'staging', required_slots: 12 });
    // The fence exists before any platform call.
    const fence = await testEnv.DB.prepare(
      'SELECT state FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
    ).bind(first.receipt.workflow_instance_id).first();
    expect(fence).toEqual({ state: 'open' });

    const replay = await acceptCoverPublication(testEnv, {
      event, request: uploadRequest(draft.id), requestDigest: HEX_64, now,
    });
    expect(replay.accepted).toBe(false);
    expect(replay.receipt.operation_id).toBe(OPERATION);
    const receipts = await testEnv.DB.prepare(
      'SELECT count(*) AS count FROM event_cover_publish_receipts WHERE event_id = ?',
    ).bind(access.event.id).first<{ count: number }>();
    expect(receipts).toEqual({ count: 1 });
  });

  it('rejects the same operation ID with different bytes', async () => {
    const draft = await readyDraft(access);
    const event = await reload(access.event.id);
    await acceptCoverPublication(testEnv, {
      event, request: uploadRequest(draft.id), requestDigest: HEX_64, now,
    });
    await expect(acceptCoverPublication(testEnv, {
      event, request: uploadRequest(draft.id), requestDigest: OTHER_HEX, now,
    })).rejects.toMatchObject({ code: 'COVER_PUBLICATION_CONFLICT', status: 409 });
  });

  it('records a conflict for an already-stale first attempt, with no set and no workflow', async () => {
    const draft = await readyDraft(access);
    await moveEventToCompetingPreset(access.event.id);
    const event = await reload(access.event.id);

    const accepted = await acceptCoverPublication(testEnv, {
      event, request: uploadRequest(draft.id, { expectedRevision: 0 }), requestDigest: HEX_64, now,
    });

    expect(accepted.view.status).toBe('conflict');
    expect(accepted.receipt.render_set_id).toBeNull();
    // No Workflow was ever named, so none can be created, and no Images work
    // is reachable from here.
    expect(accepted.receipt.workflow_instance_id).toBeNull();
    const sets = await testEnv.DB.prepare(
      'SELECT count(*) AS count FROM event_cover_render_sets WHERE event_id = ?',
    ).bind(access.event.id).first<{ count: number }>();
    expect(sets).toEqual({ count: 0 });
    // The draft was never frozen, so the host can still correct and retry it.
    expect(await draftState(draft.id)).toBe('ready');
  });

  it('rechecks revision inside acceptance before freezing or allocating', async () => {
    const draft = await readyDraft(access);
    const staleSnapshot = await reload(access.event.id);
    await moveEventToCompetingPreset(access.event.id);

    const accepted = await acceptCoverPublication(testEnv, {
      event: staleSnapshot,
      request: uploadRequest(draft.id, { expectedRevision: 0 }),
      requestDigest: HEX_64,
      now,
    });

    expect(accepted.view.status).toBe('conflict');
    expect(accepted.receipt.render_set_id).toBeNull();
    expect(accepted.receipt.workflow_instance_id).toBeNull();
    expect(await draftState(draft.id)).toBe('ready');
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_render_sets WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_workflow_fences WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
  });

  it('does not retain a receipt when the ready draft expires before the acceptance batch', async () => {
    const draft = await readyDraft(access);
    const event = await reload(access.event.id);
    let raced = false;
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await target.prepare(`
                UPDATE event_cover_drafts SET state = 'expired' WHERE id = ? AND state = 'ready'
              `).bind(draft.id).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(acceptCoverPublication({ ...testEnv, DB: db }, {
      event, request: uploadRequest(draft.id), requestDigest: HEX_64, now,
    })).rejects.toMatchObject({ code: 'COVER_PUBLICATION_CONFLICT', status: 409 });

    expect(await draftState(draft.id)).toBe('expired');
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_publish_receipts WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_render_sets WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_workflow_fences WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
  });

  it('rechecks the retained-receipt cap in the winning acceptance statement', async () => {
    await seedRetainedReceipts(
      access.event.id,
      MAX_RETAINED_COVER_RECEIPTS_PER_EVENT - 1,
      'retained',
    );
    let raced = false;
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await seedRetainedReceipts(access.event.id, 1, 'concurrent');
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(acceptCoverPublication({ ...testEnv, DB: db }, {
      event: await reload(access.event.id),
      request: { operationId: OPERATION, expectedRevision: 0, source: { kind: 'none' } },
      requestDigest: OTHER_HEX,
      now,
    })).rejects.toMatchObject({
      code: 'COVER_PUBLICATION_CONFLICT',
      message: 'This event has as much cover history as it can hold. Try again after the next daily cleanup.',
      status: 409,
    });

    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_publish_receipts WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: MAX_RETAINED_COVER_RECEIPTS_PER_EVENT });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_publish_receipts
      WHERE event_id = ? AND operation_id = ?
    `).bind(access.event.id, OPERATION).first()).toEqual({ count: 0 });
  });

  it('charges a first-seen operation but never a replay', async () => {
    const event = await reload(access.event.id);
    for (let index = 0; index < MAX_COVER_PUBLICATIONS_PER_HOUR; index += 1) {
      const draft = await readyDraft(access, `intent-${index}`);
      await acceptCoverPublication(testEnv, {
        event,
        request: uploadRequest(draft.id, { operationId: `5f3a2b18-6c2d-4f0e-9a71-0c2d1e8b4a${10 + index}` }),
        requestDigest: HEX_64,
        now,
      });
      // Free the one-preparation slot and the live-draft slot, so the *rate*
      // budget is the only thing this measures.
      await testEnv.DB.prepare(`UPDATE event_cover_publish_receipts SET status = 'applied' WHERE event_id = ?`)
        .bind(access.event.id).run();
      await testEnv.DB.prepare(`UPDATE event_cover_drafts SET state = 'published' WHERE id = ?`)
        .bind(draft.id).run();
    }
    const extra = await readyDraft(access, 'intent-over');
    await expect(acceptCoverPublication(testEnv, {
      event,
      request: uploadRequest(extra.id, { operationId: '5f3a2b18-6c2d-4f0e-9a71-0c2d1e8b4aff' }),
      requestDigest: HEX_64,
      now,
    })).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });

    // A replay of an already-counted operation still resolves.
    const replay = await acceptCoverPublication(testEnv, {
      event,
      request: uploadRequest(extra.id, { operationId: '5f3a2b18-6c2d-4f0e-9a71-0c2d1e8b4a10' }),
      requestDigest: HEX_64,
      now,
    });
    expect(replay.accepted).toBe(false);
  });

  it('permits only one preparing publication per event', async () => {
    const first = await readyDraft(access, 'intent-1');
    const second = await readyDraft(access, 'intent-2');
    const event = await reload(access.event.id);
    await acceptCoverPublication(testEnv, {
      event, request: uploadRequest(first.id), requestDigest: HEX_64, now,
    });
    await expect(acceptCoverPublication(testEnv, {
      event,
      request: uploadRequest(second.id, { operationId: '5f3a2b18-6c2d-4f0e-9a71-0c2d1e8b4a99' }),
      requestDigest: OTHER_HEX,
      now,
    })).rejects.toMatchObject({ code: 'COVER_PUBLICATION_CONFLICT', status: 409 });
  });
});

describe('dispatch and the deletion fence', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  async function accepted() {
    const draft = await readyDraft(access);
    const event = await reload(access.event.id);
    return {
      draft,
      accepted: await acceptCoverPublication(testEnv, {
        event, request: uploadRequest(draft.id), requestDigest: HEX_64, now,
      }),
    };
  }

  it('confirms a dispatch only while the fence is still open', async () => {
    const { accepted: publication } = await accepted();
    const claim = await claimInitialCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
    });
    expect(claim).toEqual({ kind: 'claimed', dispatchGeneration: 1 });
    const workflow = fakeWorkflow();
    const confirmed = await confirmCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
      dispatchGeneration: 1,
      now,
      workflow: workflow.accessor,
    });
    expect(confirmed).toBe(true);
    const receipt = await testEnv.DB.prepare(
      'SELECT dispatch_state FROM event_cover_publish_receipts WHERE operation_id = ?',
    ).bind(OPERATION).first();
    expect(receipt).toEqual({ dispatch_state: 'confirmed' });
  });

  it('terminates the instance when deletion wins the commit/dispatch gap', async () => {
    const { accepted: publication } = await accepted();
    const claim = await claimInitialCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
    });
    expect(claim).toEqual({ kind: 'claimed', dispatchGeneration: 1 });
    // Deletion blocked the fence between the D1 commit and the platform call.
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences SET state = 'deletion-blocked'
        WHERE workflow_instance_id = ?
      `).bind(publication.receipt.workflow_instance_id),
      testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED'
        WHERE operation_id = ?
      `).bind(OPERATION),
    ]);

    const workflow = fakeWorkflow();
    const confirmed = await confirmCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
      dispatchGeneration: 1,
      now,
      workflow: workflow.accessor,
    });

    expect(confirmed).toBe(false);
    // The mandatory post-call check, and no successful dispatch recorded.
    expect(workflow.calls).toContain(`terminate:${publication.receipt.workflow_instance_id}`);
    const receipt = await testEnv.DB.prepare(
      `SELECT status, dispatch_state, retryable, failure_code
       FROM event_cover_publish_receipts WHERE operation_id = ?`,
    ).bind(OPERATION).first();
    expect(receipt).toEqual({
      status: 'failed', dispatch_state: 'creating', retryable: 0, failure_code: 'EVENT_DELETED',
    });
  });

  it('settles revision movement in the acceptance-to-claim gap without dispatch', async () => {
    const { draft, accepted: publication } = await accepted();
    await moveEventToCompetingPreset(access.event.id);

    const claim = await claimInitialCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
    });

    expect(claim).toEqual({ kind: 'unavailable' });
    expect(await testEnv.DB.prepare(`
      SELECT status, retryable, dispatch_state, dispatch_generation, render_set_id
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'conflict', retryable: 0, dispatch_state: 'pending',
      dispatch_generation: 0, render_set_id: null,
    });
    expect(await draftState(draft.id)).toBe('ready');
    expect(await testEnv.DB.prepare(`
      SELECT state, abandoned_reason FROM event_cover_render_sets WHERE id = ?
    `).bind(publication.receipt.render_set_id).first()).toEqual({
      state: 'abandoned', abandoned_reason: 'revision-conflict',
    });
    const proof = await testEnv.DB.prepare(`
      SELECT f.state, f.dispatch_generation,
        f.expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', r.updated_at, '+31 days') AS exact_proof
      FROM event_cover_workflow_fences f
      JOIN event_cover_publish_receipts r
        ON r.event_id = f.event_id AND r.workflow_instance_id = f.workflow_instance_id
      WHERE f.workflow_instance_id = ?
    `).bind(publication.receipt.workflow_instance_id).first();
    expect(proof).toEqual({ state: 'open', dispatch_generation: 0, exact_proof: 1 });
  });

  it('does not settle a newer initial claim after revision movement', async () => {
    const { accepted: publication } = await accepted();
    const first = await claimInitialCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
    });
    expect(first).toEqual({ kind: 'claimed', dispatchGeneration: 1 });
    const beforeReceipt = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first();
    const beforeFence = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(publication.receipt.workflow_instance_id).first();
    await moveEventToCompetingPreset(access.event.id);

    const second = await claimInitialCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
    });

    expect(second).toEqual({ kind: 'in-flight', dispatchGeneration: 1 });
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual(beforeReceipt);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(publication.receipt.workflow_instance_id).first()).toEqual(beforeFence);
  });

  it('does not settle a confirmed initial dispatch on raw replay', async () => {
    const { accepted: publication } = await accepted();
    await claimInitialCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
    });
    await confirmCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
      dispatchGeneration: 1,
      now,
      workflow: fakeWorkflow().accessor,
    });
    const beforeReceipt = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first();
    const beforeFence = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(publication.receipt.workflow_instance_id).first();
    await moveEventToCompetingPreset(access.event.id);

    const replay = await claimInitialCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
    });

    expect(replay).toEqual({ kind: 'confirmed' });
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual(beforeReceipt);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(publication.receipt.workflow_instance_id).first()).toEqual(beforeFence);
  });

  it('records a dispatch failure as retryable and keeps the draft frozen', async () => {
    const { draft } = await accepted();
    await markDispatchFailed(testEnv, access.event.id, OPERATION, now);
    const view = await selectEventCoverPreparation(testEnv, access.event.id, now);
    expect(view).toMatchObject({ status: 'retryable-failed', retryable: true });
    // Non-discardable through the restart window: the receipt may still apply.
    expect(await draftState(draft.id)).toBe('publishing');
  });
});

describe('side-effect-free status read', () => {
  let access: Access;
  let instanceId: string;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
    const draft = await readyDraft(access);
    const event = await reload(access.event.id);
    const publication = await acceptCoverPublication(testEnv, {
      event, request: uploadRequest(draft.id), requestDigest: HEX_64, now,
    });
    instanceId = publication.receipt.workflow_instance_id!;
  });

  async function storedStatus() {
    const row = await testEnv.DB.prepare(
      'SELECT status, retryable FROM event_cover_publish_receipts WHERE operation_id = ?',
    ).bind(OPERATION).first<{ status: string; retryable: number }>();
    return row!;
  }

  it('synthesizes a retryable view for a terminal platform state without writing it', async () => {
    const terminal: CoverWorkflowLookup[] = [
      { kind: 'status', status: 'paused' },
      { kind: 'status', status: 'errored' },
      { kind: 'status', status: 'terminated' },
      { kind: 'status', status: 'complete' },
      // Certified absence is terminal too, but it reaches this path only as a
      // classified lookup — never by the platform reporting a status string.
      { kind: 'missing' },
    ];
    for (const lookup of terminal) {
      const label = lookup.kind === 'status' ? lookup.status : lookup.kind;
      const view = await readCoverPublication(testEnv, {
        eventId: access.event.id, operationId: OPERATION, now,
        workflow: fakeWorkflow(lookup).accessor,
      });
      expect(view, label).toMatchObject({
        status: 'retryable-failed', retryable: true,
        safeFailureCode: 'COVER_RENDER_UNAVAILABLE',
      });
      // Read-only: the Workflow handler, the restart POST, and bounded cleanup
      // are the authoritative writers.
      expect(await storedStatus(), label).toEqual({ status: 'queued', retryable: 0 });
    }
  });

  it('keeps an unknown platform state preparing', async () => {
    const view = await readCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now,
      workflow: fakeWorkflow('unknown').accessor,
    });
    expect(view).toMatchObject({ status: 'preparing' });
    expect(await storedStatus()).toEqual({ status: 'queued', retryable: 0 });
  });

  it('returns a terminal receipt that wins while the platform lookup is pending', async () => {
    const workflow = fakeWorkflow('running');
    workflow.accessor.lookup = async () => {
      workflow.calls.push('lookup');
      await testEnv.DB.batch([
        competingPresetStatement(access.event.id),
        testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts
          SET status = 'applied', applied_revision = 1, retryable = 0,
              completed_profiles = 6, updated_at = ?
          WHERE operation_id = ?
        `).bind('2026-08-09T13:00:00.000Z', OPERATION),
      ]);
      return { kind: 'status', status: 'running' };
    };

    const view = await readCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(view).toMatchObject({
      status: 'applied', retryable: false, completedSteps: 6,
      updatedAt: '2026-08-09T13:00:00.000Z',
    });
    expect(workflow.calls).toEqual(['lookup']);
  });

  it('synthesizes preparing when a retained failure is actually active', async () => {
    await markDispatchFailed(testEnv, access.event.id, OPERATION, now);
    const workflow = fakeWorkflow('running');

    const view = await readCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(view).toMatchObject({
      status: 'preparing', retryable: false, safeFailureCode: null,
    });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await storedStatus()).toEqual({ status: 'failed', retryable: 1 });
  });

  it('preserves a retained failure when its platform lookup is unknown', async () => {
    await markDispatchFailed(testEnv, access.event.id, OPERATION, now);
    const workflow = fakeWorkflow('unknown');

    const view = await readCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(view).toMatchObject({ status: 'retryable-failed', retryable: true });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await storedStatus()).toEqual({ status: 'failed', retryable: 1 });
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
  ])('emits only sanitized telemetry for %s without changing D1', async (
    _label,
    lookup,
    expectedCode,
  ) => {
    const before = await storedStatus();
    const workflow = fakeWorkflow().accessor;
    if (lookup === 'throw') {
      workflow.lookup = async () => {
        throw new Error(`lookup failed for ${instanceId}: events/private/cover/secret`);
      };
    } else {
      workflow.lookup = async () => lookup;
    }
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const view = await readCoverPublication(testEnv, {
        eventId: access.event.id, operationId: OPERATION, now, workflow,
      });

      expect(view).toMatchObject({ status: 'preparing' });
      expect(await storedStatus()).toEqual(before);
      expect(reported).toHaveBeenCalledTimes(1);
      const observation = JSON.parse(String(reported.mock.calls[0]![0])) as Record<string, unknown>;
      expect(observation).toEqual({
        event: 'cover_platform_observation',
        source: 'publication',
        code: expectedCode,
      });
      expect(JSON.stringify(observation)).not.toContain('private');
      expect(JSON.stringify(observation)).not.toContain(instanceId);
    } finally {
      reported.mockRestore();
    }
  });

  it('never consults the platform once D1 is terminal', async () => {
    await testEnv.DB.prepare(`UPDATE event_cover_publish_receipts SET status = 'applied' WHERE operation_id = ?`)
      .bind(OPERATION).run();
    const workflow = fakeWorkflow('errored');
    const view = await readCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });
    expect(view).toMatchObject({ status: 'applied' });
    expect(workflow.calls).toEqual([]);
    expect(instanceId).toMatch(/^cr1-/u);
  });

  it('exposes no workflow ID, object key, recipe, or platform status', async () => {
    const view = await readCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now,
      workflow: fakeWorkflow('errored').accessor,
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(instanceId);
    expect(serialized).not.toContain('events/');
    expect(serialized).not.toContain('errored');
    expect(Object.keys(view!).sort()).toEqual([
      'completedSteps', 'operationId', 'requiredSteps', 'retryable',
      'safeFailureCode', 'status', 'updatedAt',
    ]);
  });
});

describe('operation restart', () => {
  let access: Access;
  let instanceId: string;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
    const draft = await readyDraft(access);
    const event = await reload(access.event.id);
    const publication = await acceptCoverPublication(testEnv, {
      event, request: uploadRequest(draft.id), requestDigest: HEX_64, now,
    });
    instanceId = publication.receipt.workflow_instance_id!;
    await markDispatchFailed(testEnv, access.event.id, OPERATION, now);
    // Recovery claims use D1's application clock. Keep the shared fixture
    // inside its restart window regardless of the wall clock running the test.
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+24 hours')
      WHERE operation_id = ?
    `).bind(OPERATION).run();
  });

  it('resumes a paused instance and never restarts it', async () => {
    const workflow = fakeWorkflow('paused');
    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });
    expect(result.status).toBe('restarted');
    expect(workflow.calls).toContain(`resume:${instanceId}`);
    expect(workflow.calls.some((call) => call.startsWith('restart:'))).toBe(false);
  });

  it('restarts an errored instance under the same retained ID', async () => {
    const workflow = fakeWorkflow('errored');
    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });
    expect(result.status).toBe('restarted');
    expect(workflow.calls).toContain(`restart:${instanceId}`);
    // No competitor is ever allocated: same receipt, same instance ID.
    const receipts = await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_publish_receipts WHERE event_id = ?
    `).bind(access.event.id).first<{ count: number }>();
    expect(receipts).toEqual({ count: 1 });
    const receipt = await testEnv.DB.prepare(
      'SELECT status, workflow_instance_id, dispatch_generation FROM event_cover_publish_receipts WHERE operation_id = ?',
    ).bind(OPERATION).first();
    expect(receipt).toEqual({ status: 'queued', workflow_instance_id: instanceId, dispatch_generation: 1 });
  });

  it('allows recovery at the exact retained-receipt cap because it allocates no row', async () => {
    await seedRetainedReceipts(
      access.event.id,
      MAX_RETAINED_COVER_RECEIPTS_PER_EVENT - 1,
      'restart-cap',
    );
    const workflow = fakeWorkflow('errored');

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({ status: 'restarted', retryAfterSeconds: 2 });
    expect(workflow.calls).toEqual(['lookup', `restart:${instanceId}`]);
  });

  it('refuses recovery only when retained receipts already exceed their cap', async () => {
    await seedRetainedReceipts(
      access.event.id,
      MAX_RETAINED_COVER_RECEIPTS_PER_EVENT,
      'restart-over-cap',
    );
    const beforeReceipt = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first();
    const beforeFence = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).first();
    const workflow = fakeWorkflow('errored');

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({ status: 'ineligible', retryAfterSeconds: null });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual(beforeReceipt);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).first()).toEqual(beforeFence);
  });

  it('allows recovery at the exact nonactive render-set cap because it reuses the set', async () => {
    await seedNonactiveRenderSets(
      access.event.id,
      MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT - 1,
    );
    const workflow = fakeWorkflow('errored');

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({ status: 'restarted', retryAfterSeconds: 2 });
    expect(workflow.calls).toEqual(['lookup', `restart:${instanceId}`]);
  });

  it('refuses recovery only when nonactive render sets already exceed their cap', async () => {
    await seedNonactiveRenderSets(
      access.event.id,
      MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT,
    );
    const beforeReceipt = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first();
    const beforeFence = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).first();
    const workflow = fakeWorkflow('errored');

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({ status: 'ineligible', retryAfterSeconds: null });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual(beforeReceipt);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).first()).toEqual(beforeFence);
  });

  it('refuses a failed recovery whose restart window closes during lookup', async () => {
    const workflow = fakeWorkflow('errored');
    workflow.accessor.lookup = async () => {
      workflow.calls.push('lookup');
      await testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE operation_id = ?
      `).bind(OPERATION).run();
      return { kind: 'status', status: 'errored' };
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({ status: 'ineligible', retryAfterSeconds: null });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, retryable, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'failed', retryable: 1, dispatch_state: 'failed', dispatch_generation: 0,
    });
  });

  it('recreates a confirmed-missing instance under the same fenced ID', async () => {
    const workflow = fakeWorkflow({ kind: 'missing' });
    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });
    expect(result.status).toBe('restarted');
    expect(workflow.calls).toContain(`create:${instanceId}`);
  });

  it('refuses to act on an unknown platform state', async () => {
    const workflow = fakeWorkflow('unknown');
    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });
    expect(result).toMatchObject({ status: 'unavailable', retryAfterSeconds: 5 });
    expect(workflow.calls.some((call) => call.startsWith('restart:'))).toBe(false);
    const receipt = await testEnv.DB.prepare(
      'SELECT status FROM event_cover_publish_receipts WHERE operation_id = ?',
    ).bind(OPERATION).first();
    expect(receipt).toEqual({ status: 'failed' });
  });

  it('keeps the recorded failed result when the platform reports complete', async () => {
    const beforeReceipt = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first();
    const beforeFence = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).first();
    const workflow = fakeWorkflow('complete');

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'terminal', retryAfterSeconds: null, view: { status: 'retryable-failed' },
    });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual(beforeReceipt);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).first()).toEqual(beforeFence);
  });

  it('keeps a retryable failure that wins while a complete lookup is in flight', async () => {
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'queued', retryable = 0, failure_code = NULL, dispatch_state = 'confirmed'
      WHERE operation_id = ?
    `).bind(OPERATION).run();
    const workflow = fakeWorkflow('complete');
    workflow.accessor.lookup = async () => {
      workflow.calls.push('lookup');
      await testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'failed', retryable = 1, failure_code = 'COVER_RENDER_UNAVAILABLE',
            dispatch_state = 'failed'
        WHERE operation_id = ?
      `).bind(OPERATION).run();
      return { kind: 'status', status: 'complete' };
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'terminal', retryAfterSeconds: null,
      view: { status: 'retryable-failed', safeFailureCode: 'COVER_RENDER_UNAVAILABLE' },
    });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, retryable, failure_code, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'failed', retryable: 1, failure_code: 'COVER_RENDER_UNAVAILABLE',
      dispatch_state: 'failed', dispatch_generation: 0,
    });
  });

  it('returns the applied result that wins while a complete lookup is in flight', async () => {
    const workflow = fakeWorkflow('complete');
    workflow.accessor.lookup = async () => {
      workflow.calls.push('lookup');
      await testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'applied', retryable = 0, applied_revision = 1,
            dispatch_state = 'confirmed'
        WHERE operation_id = ?
      `).bind(OPERATION).run();
      return { kind: 'status', status: 'complete' };
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'terminal', retryAfterSeconds: null,
      view: { status: 'applied', retryable: false },
    });
    expect(workflow.calls).toEqual(['lookup']);
  });

  it('returns a terminal result that wins during a nonmutating platform lookup', async () => {
    const workflow = fakeWorkflow('running');
    workflow.accessor.lookup = async () => {
      workflow.calls.push('lookup');
      await testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'conflict', retryable = 0, failure_code = NULL
        WHERE operation_id = ?
      `).bind(OPERATION).run();
      return { kind: 'status', status: 'running' };
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'terminal', retryAfterSeconds: null, view: { status: 'conflict' },
    });
    expect(workflow.calls).toEqual(['lookup']);
  });

  it('returns fresh progress written during a nonmutating platform lookup', async () => {
    const progressedAt = '2026-08-04T12:00:01.000Z';
    const workflow = fakeWorkflow('running');
    workflow.accessor.lookup = async () => {
      workflow.calls.push('lookup');
      await testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts SET completed_profiles = 3, updated_at = ?
        WHERE operation_id = ?
      `).bind(progressedAt, OPERATION).run();
      return { kind: 'status', status: 'running' };
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'active', retryAfterSeconds: 2,
      view: { status: 'preparing', completedSteps: 3, updatedAt: progressedAt },
    });
    expect(workflow.calls).toEqual(['lookup']);
  });

  it.each(['queued', 'running', 'waiting', 'waitingForPause'] as const)(
    'polls without mutating a failed receipt while the platform is %s',
    async (status) => {
      const beforeReceipt = await testEnv.DB.prepare(`
        SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
      `).bind(OPERATION).first();
      const beforeFence = await testEnv.DB.prepare(`
        SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
      `).bind(instanceId).first();
      const workflow = fakeWorkflow(status);

      const result = await restartCoverPublication(testEnv, {
        eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
      });

      expect(result).toMatchObject({
        status: 'active', retryAfterSeconds: 2,
        view: { status: 'preparing', retryable: false, safeFailureCode: null },
      });
      expect(workflow.calls).toEqual(['lookup']);
      expect(await testEnv.DB.prepare(`
        SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
      `).bind(OPERATION).first()).toEqual(beforeReceipt);
      expect(await testEnv.DB.prepare(`
        SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
      `).bind(instanceId).first()).toEqual(beforeFence);
    },
  );

  it('refuses a permanent failure, a terminal receipt, and a lapsed restart window', async () => {
    await testEnv.DB.prepare('UPDATE event_cover_publish_receipts SET retryable = 0 WHERE operation_id = ?')
      .bind(OPERATION).run();
    const permanentWorkflow = fakeWorkflow('errored');
    expect((await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: permanentWorkflow.accessor,
    })).status).toBe('terminal');
    expect(permanentWorkflow.calls).toEqual([]);

    await testEnv.DB.prepare(`UPDATE event_cover_publish_receipts SET status = 'applied' WHERE operation_id = ?`)
      .bind(OPERATION).run();
    expect((await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: fakeWorkflow('errored').accessor,
    })).status).toBe('terminal');

    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 1, expires_at = ? WHERE operation_id = ?
    `).bind(new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), OPERATION).run();
    const late = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    expect((await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now: late,
      workflow: fakeWorkflow('errored').accessor,
    })).status).toBe('ineligible');
  });

  it('does not mutate the platform when deletion blocked the fence before the claim', async () => {
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences SET state = 'deletion-blocked' WHERE workflow_instance_id = ?
    `).bind(instanceId).run();
    const workflow = fakeWorkflow('errored');
    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });
    expect(result.status).toBe('ineligible');
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, failure_code
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'failed', dispatch_state: 'failed', dispatch_generation: 0,
      failure_code: 'COVER_RENDER_UNAVAILABLE',
    });
  });

  it('does not mutate the platform when the exact fence is missing before the claim', async () => {
    await testEnv.DB.prepare(`
      DELETE FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).run();
    const workflow = fakeWorkflow('errored');

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result.status).toBe('ineligible');
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({ dispatch_state: 'failed', dispatch_generation: 0 });
  });

  it('does not mutate the platform when the fence generation mismatches before the claim', async () => {
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences SET dispatch_generation = 4
      WHERE workflow_instance_id = ?
    `).bind(instanceId).run();
    const workflow = fakeWorkflow('errored');

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result.status).toBe('ineligible');
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({ dispatch_state: 'failed', dispatch_generation: 0 });
  });

  it('keeps a rejected restart claim recoverable when its follow-up lookup is unknown', async () => {
    const workflow = rejectingRestartWorkflow({ kind: 'unknown', telemetry: 'test-unknown' });

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({ status: 'unavailable', retryAfterSeconds: 5 });
    expect(workflow.calls).toEqual(['lookup', `restart:${instanceId}`, 'lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, failure_code, retryable
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'queued', dispatch_state: 'restarting', dispatch_generation: 1,
      failure_code: null, retryable: 1,
    });
  });

  it('runs the deletion guard after a rejected restart has an unknown follow-up', async () => {
    const workflow = rejectingRestartWorkflow(
      { kind: 'unknown', telemetry: 'test-unknown' },
      async () => {
        await testEnv.DB.batch([
          testEnv.DB.prepare(`
            UPDATE event_cover_workflow_fences SET state = 'deletion-blocked'
            WHERE workflow_instance_id = ?
          `).bind(instanceId),
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED'
            WHERE operation_id = ?
          `).bind(OPERATION),
        ]);
      },
    );

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result.status).toBe('terminal');
    expect(workflow.calls).toEqual([
      'lookup', `restart:${instanceId}`, 'lookup', `terminate:${instanceId}`,
    ]);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, failure_code, retryable
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'failed', dispatch_state: 'restarting', dispatch_generation: 1,
      failure_code: 'EVENT_DELETED', retryable: 0,
    });
  });

  it('keeps a rejected restart claim recoverable when its follow-up status is unmapped', async () => {
    const workflow = rejectingRestartWorkflow({
      kind: 'status', status: 'events/private/cover/cr1-secret',
    });
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const result = await restartCoverPublication(testEnv, {
        eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
      });

      expect(result).toMatchObject({ status: 'unavailable', retryAfterSeconds: 5 });
      expect(workflow.calls).toEqual(['lookup', `restart:${instanceId}`, 'lookup']);
      expect(await testEnv.DB.prepare(`
        SELECT status, dispatch_state, dispatch_generation, failure_code, retryable
        FROM event_cover_publish_receipts WHERE operation_id = ?
      `).bind(OPERATION).first()).toEqual({
        status: 'queued', dispatch_state: 'restarting', dispatch_generation: 1,
        failure_code: null, retryable: 1,
      });
      expect(reported).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(reported.mock.calls[0]![0]))).toEqual({
        event: 'cover_platform_observation',
        source: 'publication',
        code: 'cover_platform_unmapped',
      });
      expect(String(reported.mock.calls[0]![0])).not.toContain('private');
    } finally {
      reported.mockRestore();
    }
  });

  it('confirms a rejected restart when its follow-up lookup proves the instance active', async () => {
    const workflow = rejectingRestartWorkflow({ kind: 'status', status: 'running' });

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result.status).toBe('restarted');
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, failure_code
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'queued', dispatch_state: 'confirmed', dispatch_generation: 1, failure_code: null,
    });
  });

  it('does not reclaim a young recovery while its first platform call is still pending', async () => {
    let releaseFirst!: () => void;
    let reportEntered!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { reportEntered = resolve; });
    let restartCalls = 0;
    const workflow = fakeWorkflow('errored');
    workflow.accessor.restart = async (id) => {
      workflow.calls.push(`restart:${id}`);
      restartCalls += 1;
      if (restartCalls === 1) {
        reportEntered();
        await release;
      }
    };

    const first = restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });
    await entered;

    const second = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(second).toMatchObject({
      status: 'active', retryAfterSeconds: 2, view: { status: 'preparing' },
    });
    expect(restartCalls).toBe(1);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'queued', dispatch_state: 'restarting', dispatch_generation: 1,
    });

    releaseFirst();
    expect((await first).status).toBe('restarted');
    expect(restartCalls).toBe(1);
    expect(await testEnv.DB.prepare(`
      SELECT dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({ dispatch_state: 'confirmed', dispatch_generation: 1 });
  });

  it.each(['errored', 'running'] as const)(
    'keeps a young exact recovery temporary after retryable failure while platform is %s',
    async (platformStatus) => {
      await testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'failed', retryable = 1, dispatch_state = 'restarting',
            last_dispatch_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE operation_id = ?
      `).bind(OPERATION).run();
      const workflow = fakeWorkflow(platformStatus);

      const result = await restartCoverPublication(testEnv, {
        eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
      });

      expect(result).toMatchObject({
        status: 'active', retryAfterSeconds: 2, view: { status: 'preparing' },
      });
      expect(workflow.calls).toEqual(['lookup']);
      expect(await testEnv.DB.prepare(`
        SELECT status, retryable, dispatch_state, dispatch_generation
        FROM event_cover_publish_receipts WHERE operation_id = ?
      `).bind(OPERATION).first()).toEqual({
        status: 'failed', retryable: 1, dispatch_state: 'restarting', dispatch_generation: 0,
      });
    },
  );

  it('returns active when the same dispatch generation progresses during lookup', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'queued', retryable = 1, dispatch_state = 'creating',
            dispatch_generation = 1, last_dispatch_at = '2000-01-01T00:00:00.000Z'
        WHERE operation_id = ?
      `).bind(OPERATION),
      testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences SET dispatch_generation = 1
        WHERE workflow_instance_id = ?
      `).bind(instanceId),
    ]);
    const workflow = fakeWorkflow('running');
    workflow.accessor.lookup = async () => {
      workflow.calls.push('lookup');
      await testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'rendering', dispatch_state = 'confirmed', completed_profiles = 2
        WHERE operation_id = ? AND dispatch_generation = 1
      `).bind(OPERATION).run();
      return { kind: 'status', status: 'running' };
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'active', retryAfterSeconds: 2,
      view: { status: 'preparing', completedSteps: 2 },
    });
    expect(workflow.calls).toEqual(['lookup']);
  });

  it('returns active when lookup overlaps a newer confirmed generation', async () => {
    const workflow = fakeWorkflow('running');
    workflow.accessor.lookup = async () => {
      workflow.calls.push('lookup');
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts
          SET status = 'queued', retryable = 1, dispatch_state = 'confirmed',
              dispatch_generation = 1, failure_code = NULL
          WHERE operation_id = ?
        `).bind(OPERATION),
        testEnv.DB.prepare(`
          UPDATE event_cover_workflow_fences SET dispatch_generation = 1
          WHERE workflow_instance_id = ?
        `).bind(instanceId),
      ]);
      return { kind: 'status', status: 'running' };
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'active', retryAfterSeconds: 2, view: { status: 'preparing' },
    });
    expect(workflow.calls).toEqual(['lookup']);
  });

  it('confirms a stale exact recovery claim when the retained instance is active', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'queued', retryable = 1, dispatch_state = 'restarting',
            dispatch_generation = 1, last_dispatch_at = '2000-01-01T00:00:00.000Z'
        WHERE operation_id = ?
      `).bind(OPERATION),
      testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences SET dispatch_generation = 1
        WHERE workflow_instance_id = ?
      `).bind(instanceId),
    ]);
    const workflow = fakeWorkflow('running');

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'active', retryAfterSeconds: 2, view: { status: 'preparing' },
    });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'queued', dispatch_state: 'confirmed', dispatch_generation: 1,
    });
  });

  it('does not settle a young in-flight recovery after revision movement', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'queued', dispatch_state = 'restarting', dispatch_generation = 1,
            last_dispatch_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE operation_id = ?
      `).bind(OPERATION),
      testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences SET dispatch_generation = 1
        WHERE workflow_instance_id = ?
      `).bind(instanceId),
      competingPresetStatement(access.event.id),
    ]);
    const beforeReceipt = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first();
    const beforeFence = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).first();
    const workflow = fakeWorkflow('errored');

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'active', retryAfterSeconds: 2, view: { status: 'preparing' },
    });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual(beforeReceipt);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).first()).toEqual(beforeFence);
  });

  it('returns a terminal result when a rejected restart already applied in D1', async () => {
    const workflow = rejectingRestartWorkflow(
      { kind: 'status', status: 'complete' },
      async () => {
        await testEnv.DB.batch([
          competingPresetStatement(access.event.id),
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET status = 'applied', applied_revision = 1, retryable = 0
            WHERE operation_id = ?
          `).bind(OPERATION),
        ]);
      },
    );

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'terminal', retryAfterSeconds: null, view: { status: 'applied' },
    });
    expect(await testEnv.DB.prepare(`
      SELECT status, applied_revision, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'applied', applied_revision: 1,
      dispatch_state: 'confirmed', dispatch_generation: 1,
    });
    expect(workflow.calls).not.toContain(`terminate:${instanceId}`);
  });

  it('does not overwrite deletion settlement after a rejected restart', async () => {
    const workflow = rejectingRestartWorkflow(
      { kind: 'status', status: 'errored' },
      async () => {
        await testEnv.DB.batch([
          testEnv.DB.prepare(`
            UPDATE event_cover_workflow_fences SET state = 'deletion-blocked'
            WHERE workflow_instance_id = ?
          `).bind(instanceId),
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED'
            WHERE operation_id = ?
          `).bind(OPERATION),
        ]);
      },
    );

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result.status).toBe('terminal');
    expect(workflow.calls).toEqual([
      'lookup', `restart:${instanceId}`, 'lookup', `terminate:${instanceId}`,
    ]);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, failure_code, retryable
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'failed', dispatch_state: 'restarting', dispatch_generation: 1,
      failure_code: 'EVENT_DELETED', retryable: 0,
    });
  });

  it('does not overwrite a newer generation after a rejected restart', async () => {
    const workflow = rejectingRestartWorkflow(
      { kind: 'status', status: 'errored' },
      async () => {
        await testEnv.DB.batch([
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET dispatch_generation = 2, dispatch_state = 'restarting'
            WHERE operation_id = ?
          `).bind(OPERATION),
          testEnv.DB.prepare(`
            UPDATE event_cover_workflow_fences SET dispatch_generation = 2
            WHERE workflow_instance_id = ?
          `).bind(instanceId),
        ]);
      },
    );

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'active', retryAfterSeconds: 2, view: { status: 'preparing' },
    });
    expect(workflow.calls).not.toContain(`terminate:${instanceId}`);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, failure_code
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'queued', dispatch_state: 'restarting', dispatch_generation: 2, failure_code: null,
    });
  });

  it('does not settle a recovery generation claimed after its lookup', async () => {
    const workflow = fakeWorkflow('errored');
    workflow.accessor.lookup = async () => {
      workflow.calls.push('lookup');
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts
          SET status = 'queued', dispatch_state = 'restarting', dispatch_generation = 1,
              last_dispatch_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE operation_id = ?
        `).bind(OPERATION),
        testEnv.DB.prepare(`
          UPDATE event_cover_workflow_fences SET dispatch_generation = 1
          WHERE workflow_instance_id = ?
        `).bind(instanceId),
        competingPresetStatement(access.event.id),
      ]);
      return { kind: 'status', status: 'errored' };
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'active', retryAfterSeconds: 2, view: { status: 'preparing' },
    });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, render_set_id
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toMatchObject({
      status: 'queued', dispatch_state: 'restarting', dispatch_generation: 1,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, dispatch_generation FROM event_cover_workflow_fences
      WHERE workflow_instance_id = ?
    `).bind(instanceId).first()).toEqual({ state: 'open', dispatch_generation: 1 });
  });

  it('polls when a newer generation finishes back in a retryable failed state', async () => {
    const workflow = fakeWorkflow('errored');
    workflow.accessor.lookup = async () => {
      workflow.calls.push('lookup');
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts
          SET status = 'failed', retryable = 1, dispatch_state = 'failed',
              dispatch_generation = 1, failure_code = 'COVER_RENDER_UNAVAILABLE'
          WHERE operation_id = ?
        `).bind(OPERATION),
        testEnv.DB.prepare(`
          UPDATE event_cover_workflow_fences SET dispatch_generation = 1
          WHERE workflow_instance_id = ?
        `).bind(instanceId),
      ]);
      return { kind: 'status', status: 'errored' };
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'unavailable', retryAfterSeconds: 5,
      view: { status: 'retryable-failed' },
    });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, retryable, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'failed', retryable: 1, dispatch_state: 'failed', dispatch_generation: 1,
    });
  });

  it('returns a terminal result that wins between the final receipt and fence reads', async () => {
    const workflow = fakeWorkflow('errored');
    let claimRaced = false;
    let fenceReads = 0;
    const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        if (property === 'first') {
          return async <T = unknown>(columnName?: string) => {
            fenceReads += 1;
            if (fenceReads === 2) {
              await testEnv.DB.prepare(`
                UPDATE event_cover_publish_receipts
                SET status = 'applied', retryable = 0, dispatch_state = 'confirmed',
                    applied_revision = 1, failure_code = NULL
                WHERE operation_id = ?
              `).bind(OPERATION).run();
            }
            return columnName === undefined
              ? target.first<T>()
              : target.first<T>(columnName);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!claimRaced) {
              claimRaced = true;
              await testEnv.DB.batch([
                testEnv.DB.prepare(`
                  UPDATE event_cover_publish_receipts
                  SET status = 'failed', retryable = 1, dispatch_state = 'failed',
                      dispatch_generation = 1, failure_code = 'COVER_RENDER_UNAVAILABLE'
                  WHERE operation_id = ?
                `).bind(OPERATION),
                testEnv.DB.prepare(`
                  UPDATE event_cover_workflow_fences SET dispatch_generation = 1
                  WHERE workflow_instance_id = ?
                `).bind(instanceId),
              ]);
            }
            return target.batch(statements);
          };
        }
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.includes('event_cover_workflow_fences') ? wrapStatement(statement) : statement;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await restartCoverPublication({ ...testEnv, DB: db }, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(fenceReads).toBe(2);
    expect(result).toMatchObject({
      status: 'terminal', retryAfterSeconds: null, view: { status: 'applied' },
    });
    expect(workflow.calls).toEqual(['lookup']);
  });

  it('uses the D1 application clock for a recovery claim', async () => {
    const requested = new Date('2020-01-01T00:00:00.000Z');
    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now: requested,
      workflow: fakeWorkflow('paused').accessor,
    });

    expect(result.status).toBe('restarted');
    const receipt = await testEnv.DB.prepare(`
      SELECT last_dispatch_at FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first<{ last_dispatch_at: string }>();
    const fence = await testEnv.DB.prepare(`
      SELECT updated_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).first<{ updated_at: string }>();
    expect(receipt?.last_dispatch_at).not.toBe(requested.toISOString());
    expect(fence?.updated_at).not.toBe(requested.toISOString());
  });

  it('settles stale recovery after a newer publication moved the revision', async () => {
    const before = await testEnv.DB.prepare(`
      SELECT draft_id, render_set_id FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first<{ draft_id: string; render_set_id: string }>();
    await moveEventToCompetingPreset(access.event.id);
    const workflow = fakeWorkflow('errored');
    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });
    expect(result).toMatchObject({ status: 'terminal', view: { status: 'conflict' } });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, retryable, dispatch_state, dispatch_generation, render_set_id
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'conflict', retryable: 0, dispatch_state: 'failed',
      dispatch_generation: 0, render_set_id: null,
    });
    expect(await draftState(before!.draft_id)).toBe('ready');
    expect(await testEnv.DB.prepare(`
      SELECT state, abandoned_reason FROM event_cover_render_sets WHERE id = ?
    `).bind(before!.render_set_id).first()).toEqual({
      state: 'abandoned', abandoned_reason: 'revision-conflict',
    });
    expect(await testEnv.DB.prepare(`
      SELECT f.expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', r.updated_at, '+31 days') AS exact_proof
      FROM event_cover_workflow_fences f
      JOIN event_cover_publish_receipts r
        ON r.event_id = f.event_id AND r.workflow_instance_id = f.workflow_instance_id
      WHERE f.workflow_instance_id = ?
    `).bind(instanceId).first()).toEqual({ exact_proof: 1 });
  });

  it('takes over and terminates a stale active generation before revision settlement', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'queued', retryable = 1, dispatch_state = 'restarting',
            dispatch_generation = 1, last_dispatch_at = '2000-01-01T00:00:00.000Z'
        WHERE operation_id = ?
      `).bind(OPERATION),
      testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences SET dispatch_generation = 1
        WHERE workflow_instance_id = ?
      `).bind(instanceId),
      competingPresetStatement(access.event.id),
    ]);
    let platformStatus: CoverPlatformStatus = 'errored';
    const calls: string[] = [];
    const workflow: CoverWorkflowAccessor = {
      async create() {},
      async lookup() {
        calls.push('lookup');
        return { kind: 'status', status: platformStatus };
      },
      async resume() {},
      async restart(id) {
        calls.push(`restart:${id}`);
        platformStatus = 'running';
      },
      async terminate(id) {
        calls.push(`terminate:${id}`);
        platformStatus = 'terminated';
      },
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow,
    });

    expect(result).toMatchObject({ status: 'terminal', view: { status: 'conflict' } });
    expect(calls).toEqual(['lookup', `terminate:${instanceId}`, 'lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, render_set_id
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'conflict', dispatch_state: 'restarting', dispatch_generation: 2,
      render_set_id: null,
    });

    // A delayed generation-one host can still return from its platform call,
    // but it no longer owns D1 confirmation or the generation-two fence.
    await workflow.restart(instanceId);
    expect(await confirmCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: instanceId,
      dispatchGeneration: 1,
      from: 'restarting',
      now,
      workflow,
    })).toBe(false);
    expect(calls.slice(-2)).toEqual([`restart:${instanceId}`, `terminate:${instanceId}`]);
    expect(platformStatus).toBe('terminated');
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'conflict', dispatch_state: 'restarting', dispatch_generation: 2,
    });

    // Purge can later preserve that exact terminal proof while tagging the
    // superseding generation deletion-blocked. A still-later generation-one
    // platform call must be terminated just as it was for the open proof.
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET state = 'deletion-blocked', expires_at = expires_at || '|cf2'
      WHERE workflow_instance_id = ?
    `).bind(instanceId).run();
    await workflow.restart(instanceId);
    expect(await confirmCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: instanceId,
      dispatchGeneration: 1,
      from: 'restarting',
      now,
      workflow,
    })).toBe(false);
    expect(calls.slice(-2)).toEqual([`restart:${instanceId}`, `terminate:${instanceId}`]);
    expect(platformStatus).toBe('terminated');
  });

  it('terminates a delayed older call after relational purge retains only newer terminal proof', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'conflict', retryable = 0, dispatch_state = 'restarting',
            dispatch_generation = 3, updated_at = ?
        WHERE operation_id = ?
      `).bind(now.toISOString(), OPERATION),
      testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences
        SET state = 'deletion-blocked', dispatch_generation = 3,
            updated_at = ?, expires_at = '2026-09-04T12:00:00.000Z|cf2'
        WHERE workflow_instance_id = ?
      `).bind(now.toISOString(), instanceId),
      testEnv.DB.prepare(`
        DELETE FROM event_cover_publish_receipts WHERE operation_id = ?
      `).bind(OPERATION),
      testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
        .bind(now.toISOString(), access.event.id),
    ]);
    const workflow = fakeWorkflow('running');

    expect(await confirmCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: instanceId,
      dispatchGeneration: 2,
      from: 'restarting',
      now,
      workflow: workflow.accessor,
    })).toBe(false);

    expect(workflow.calls).toEqual([`terminate:${instanceId}`]);
  });

  it('terminates a delayed older call while a newer deletion-blocked purge is unresolved', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED',
            dispatch_state = 'blocked', dispatch_generation = 3
        WHERE operation_id = ?
      `).bind(OPERATION),
      testEnv.DB.prepare(`
        UPDATE event_cover_workflow_fences
        SET state = 'deletion-blocked', dispatch_generation = 3
        WHERE workflow_instance_id = ?
      `).bind(instanceId),
      testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
        .bind(now.toISOString(), access.event.id),
    ]);
    const workflow = fakeWorkflow('running');

    expect(await confirmCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: instanceId,
      dispatchGeneration: 2,
      from: 'restarting',
      now,
      workflow: workflow.accessor,
    })).toBe(false);

    expect(workflow.calls).toEqual([`terminate:${instanceId}`]);
  });

  it('terminates a paused stale publication before settling its revision conflict', async () => {
    await moveEventToCompetingPreset(access.event.id);
    let platformStatus: CoverPlatformStatus = 'paused';
    const calls: string[] = [];
    const workflow: CoverWorkflowAccessor = {
      async create(id) { calls.push(`create:${id}`); },
      async lookup() {
        calls.push('lookup');
        return { kind: 'status', status: platformStatus };
      },
      async resume(id) { calls.push(`resume:${id}`); },
      async restart(id) { calls.push(`restart:${id}`); },
      async terminate(id) {
        calls.push(`terminate:${id}`);
        platformStatus = 'terminated';
      },
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow,
    });

    expect(result).toMatchObject({ status: 'terminal', view: { status: 'conflict' } });
    expect(calls).toEqual(['lookup', `terminate:${instanceId}`, 'lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, retryable, dispatch_state, dispatch_generation, render_set_id
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'conflict', retryable: 0, dispatch_state: 'resuming',
      dispatch_generation: 1, render_set_id: null,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, dispatch_generation,
        expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+31 days') AS exact_proof
      FROM event_cover_workflow_fences WHERE workflow_instance_id = ?
    `).bind(instanceId).first()).toEqual({
      state: 'open', dispatch_generation: 1, exact_proof: 1,
    });
  });

  it.each(['queued', 'rendering', 'finalizing'] as const)(
    'terminates paused %s state after revision movement, including a ready set',
    async (status) => {
      const before = await testEnv.DB.prepare(`
        SELECT render_set_id FROM event_cover_publish_receipts WHERE operation_id = ?
      `).bind(OPERATION).first<{ render_set_id: string }>();
      if (status === 'finalizing') {
        await completeRenderSet(access.event.id, before!.render_set_id);
      }
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts
          SET status = ?, retryable = 0, dispatch_state = 'confirmed'
          WHERE operation_id = ?
        `).bind(status, OPERATION),
        testEnv.DB.prepare(`
          UPDATE event_cover_render_sets SET state = ? WHERE id = ?
        `).bind(status === 'finalizing' ? 'ready' : 'staging', before!.render_set_id),
        competingPresetStatement(access.event.id),
      ]);
      let platformStatus: CoverPlatformStatus = 'paused';
      const calls: string[] = [];
      const workflow: CoverWorkflowAccessor = {
        async create() {},
        async lookup() {
          calls.push('lookup');
          return { kind: 'status', status: platformStatus };
        },
        async resume() {},
        async restart() {},
        async terminate(id) {
          calls.push(`terminate:${id}`);
          platformStatus = 'terminated';
        },
      };

      const result = await restartCoverPublication(testEnv, {
        eventId: access.event.id, operationId: OPERATION, now, workflow,
      });

      expect(result).toMatchObject({ status: 'terminal', view: { status: 'conflict' } });
      expect(calls).toEqual(['lookup', `terminate:${instanceId}`, 'lookup']);
      expect(await testEnv.DB.prepare(`
        SELECT status, render_set_id FROM event_cover_publish_receipts WHERE operation_id = ?
      `).bind(OPERATION).first()).toEqual({ status: 'conflict', render_set_id: null });
      expect(await testEnv.DB.prepare(`
        SELECT state, abandoned_reason FROM event_cover_render_sets WHERE id = ?
      `).bind(before!.render_set_id).first()).toEqual({
        state: 'abandoned', abandoned_reason: 'revision-conflict',
      });
    },
  );

  it('preserves deletion when it wins during paused conflict termination', async () => {
    await moveEventToCompetingPreset(access.event.id);
    let platformStatus: CoverPlatformStatus = 'paused';
    const calls: string[] = [];
    const workflow: CoverWorkflowAccessor = {
      async create() {},
      async lookup() {
        calls.push('lookup');
        return { kind: 'status', status: platformStatus };
      },
      async resume() {},
      async restart() {},
      async terminate(id) {
        calls.push(`terminate:${id}`);
        await testEnv.DB.batch([
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED',
                dispatch_state = 'blocked'
            WHERE event_id = ? AND operation_id = ? AND dispatch_generation = 1
          `).bind(access.event.id, OPERATION),
          testEnv.DB.prepare(`
            UPDATE event_cover_workflow_fences SET state = 'deletion-blocked'
            WHERE workflow_instance_id = ? AND dispatch_generation = 1
          `).bind(instanceId),
        ]);
        platformStatus = 'terminated';
      },
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow,
    });

    expect(result).toMatchObject({
      status: 'terminal', view: { status: 'permanent-failed', safeFailureCode: 'EVENT_DELETED' },
    });
    expect(calls).toEqual(['lookup', `terminate:${instanceId}`, 'lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, retryable, failure_code, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'failed', retryable: 0, failure_code: 'EVENT_DELETED',
      dispatch_state: 'blocked', dispatch_generation: 1,
    });
  });

  it('does not settle a newer generation that wins during paused conflict termination', async () => {
    await moveEventToCompetingPreset(access.event.id);
    let platformStatus: CoverPlatformStatus = 'paused';
    const workflow: CoverWorkflowAccessor = {
      async create() {},
      async lookup() { return { kind: 'status', status: platformStatus }; },
      async resume() {},
      async restart() {},
      async terminate() {
        await testEnv.DB.batch([
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET status = 'queued', dispatch_state = 'restarting', dispatch_generation = 2,
                last_dispatch_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE event_id = ? AND operation_id = ? AND dispatch_generation = 1
          `).bind(access.event.id, OPERATION),
          testEnv.DB.prepare(`
            UPDATE event_cover_workflow_fences SET dispatch_generation = 2
            WHERE workflow_instance_id = ? AND dispatch_generation = 1
          `).bind(instanceId),
        ]);
        platformStatus = 'terminated';
      },
    };

    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow,
    });

    expect(result).toMatchObject({
      status: 'active', retryAfterSeconds: 2, view: { status: 'preparing' },
    });
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, render_set_id
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toMatchObject({
      status: 'queued', dispatch_state: 'restarting', dispatch_generation: 2,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, dispatch_generation FROM event_cover_workflow_fences
      WHERE workflow_instance_id = ?
    `).bind(instanceId).first()).toEqual({ state: 'open', dispatch_generation: 2 });
  });

  it('returns a terminal result that wins immediately before a paused conflict claim', async () => {
    await moveEventToCompetingPreset(access.event.id);
    let batches = 0;
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            batches += 1;
            if (batches === 2) {
              await target.prepare(`
                UPDATE event_cover_publish_receipts
                SET status = 'conflict', retryable = 0, failure_code = NULL
                WHERE event_id = ? AND operation_id = ?
              `).bind(access.event.id, OPERATION).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const workflow = fakeWorkflow('paused');

    const result = await restartCoverPublication({ ...testEnv, DB: db }, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });

    expect(result).toMatchObject({
      status: 'terminal', retryAfterSeconds: null, view: { status: 'conflict' },
    });
    expect(workflow.calls).toEqual(['lookup']);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(OPERATION).first()).toEqual({
      status: 'conflict', dispatch_state: 'failed', dispatch_generation: 0,
    });
  });
});

describe('synchronous removal publication', () => {
  let access: Access;
  const legacyKey = (id: string) => `events/${id}/cover/9f1c-porch.jpg`;

  beforeEach(async () => {
    // Preserve the deployed phase-2 legacy writer contract on the exact schema
    // where legacy pointers can still exist. 0014 itself proves they are gone.
    await reset();
    await applyD1Migrations(testEnv.DB, migrationsUpTo('0014'));
    access = await eventAccess();
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
      .bind(legacyKey(access.event.id), access.event.id).run();
    await testEnv.MEDIA_BUCKET.put(legacyKey(access.event.id), new Uint8Array([1, 2, 3]));
  });

  async function acceptRemoval(expectedRevision = 0) {
    const event = await reload(access.event.id);
    return acceptCoverPublication(testEnv, {
      event,
      request: { operationId: OPERATION, expectedRevision, source: { kind: 'none' } },
      requestDigest: HEX_64,
      now,
    });
  }

  /** Reconstructs the pre-atomic-acceptance row shape for upgrade/race tests. */
  async function seedPendingRemoval() {
    await acceptRemoval();
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE events SET cover_object_key = ?, cover_render_set_id = NULL, cover_revision = 0
        WHERE id = ?
      `).bind(legacyKey(access.event.id), access.event.id),
      testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'queued', applied_revision = NULL, result_cover_json = NULL,
            retryable = 0, failure_code = NULL, dispatch_state = 'pending'
        WHERE event_id = ? AND operation_id = ?
      `).bind(access.event.id, OPERATION),
      testEnv.DB.prepare(`
        DELETE FROM event_cover_retired_legacy_objects WHERE event_id = ?
      `).bind(access.event.id),
    ]);
    return reload(access.event.id);
  }

  it('applies the removal in the same durable transaction as first acceptance', async () => {
    const accepted = await acceptRemoval();

    expect(accepted).toMatchObject({
      accepted: true,
      receipt: { status: 'applied', applied_revision: 1 },
      view: { status: 'applied' },
    });
    expect((await reload(access.event.id)).coverObjectKey).toBeNull();
    expect((await reload(access.event.id)).coverRevision).toBe(1);
    expect(await testEnv.DB.prepare(`
      SELECT object_key, reason FROM event_cover_retired_legacy_objects WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({
      object_key: legacyKey(access.event.id), reason: 'removed',
    });
  });

  it('applies in one transaction, retires the original into inventory, and does not delete it', async () => {
    await acceptRemoval();
    const outcome = await applyRemovalPublication(testEnv, {
      event: await reload(access.event.id),
      operationId: OPERATION, requestDigest: HEX_64, expectedRevision: 0, now,
    });

    expect(outcome).toMatchObject({ applied: true, appliedRevision: 1 });
    const event = await reload(access.event.id);
    expect(event.coverObjectKey).toBeNull();
    expect(event.coverRevision).toBe(1);
    expect(event.coverConfig).toBe('{"version":1,"source":{"kind":"none"}}');

    const retired = await testEnv.DB.prepare(
      'SELECT object_key, reason FROM event_cover_retired_legacy_objects WHERE event_id = ?',
    ).bind(access.event.id).first();
    expect(retired).toEqual({ object_key: legacyKey(access.event.id), reason: 'removed' });
    // Only bounded cleanup may delete it, and only after the recovery window.
    expect(await testEnv.MEDIA_BUCKET.head(legacyKey(access.event.id))).not.toBeNull();
  });

  it('is idempotent under replay', async () => {
    await acceptRemoval();
    await applyRemovalPublication(testEnv, {
      event: await reload(access.event.id),
      operationId: OPERATION, requestDigest: HEX_64, expectedRevision: 0, now,
    });
    const replay = await applyRemovalPublication(testEnv, {
      event: await reload(access.event.id),
      operationId: OPERATION, requestDigest: HEX_64, expectedRevision: 0, now,
    });
    expect(replay).toMatchObject({ applied: true, appliedRevision: 1 });
    // The revision moved exactly once, however many times the response was lost.
    expect((await reload(access.event.id)).coverRevision).toBe(1);
    const retired = await testEnv.DB.prepare(
      'SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?',
    ).bind(access.event.id).first<{ count: number }>();
    expect(retired).toEqual({ count: 1 });
  });

  it('replays a permanent deletion result without reviving the removal', async () => {
    await seedPendingRemoval();
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED',
          dispatch_state = 'blocked'
      WHERE event_id = ? AND operation_id = ?
    `).bind(access.event.id, OPERATION).run();
    const beforeEvent = await testEnv.DB.prepare('SELECT * FROM events WHERE id = ?')
      .bind(access.event.id).first();
    const beforeReceipt = await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?
    `).bind(access.event.id, OPERATION).first();

    const outcome = await applyRemovalPublication(testEnv, {
      event: await reload(access.event.id),
      operationId: OPERATION, requestDigest: HEX_64, expectedRevision: 0, now,
    });

    expect(outcome).toMatchObject({ applied: false, appliedRevision: null });
    expect(outcome.view).toMatchObject({
      status: 'permanent-failed', retryable: false, safeFailureCode: 'EVENT_DELETED',
    });
    expect(await testEnv.DB.prepare('SELECT * FROM events WHERE id = ?')
      .bind(access.event.id).first()).toEqual(beforeEvent);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?
    `).bind(access.event.id, OPERATION).first()).toEqual(beforeReceipt);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
  });

  it('preserves a deletion result that wins immediately before the removal batch', async () => {
    const event = await seedPendingRemoval();
    let raced = false;
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await target.prepare(`
                UPDATE event_cover_publish_receipts
                SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED',
                    dispatch_state = 'blocked'
                WHERE event_id = ? AND operation_id = ?
              `).bind(access.event.id, OPERATION).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const outcome = await applyRemovalPublication({ ...testEnv, DB: db }, {
      event, operationId: OPERATION, requestDigest: HEX_64, expectedRevision: 0, now,
    });

    expect(outcome).toMatchObject({ applied: false, appliedRevision: null });
    expect(outcome.view).toMatchObject({
      status: 'permanent-failed', retryable: false, safeFailureCode: 'EVENT_DELETED',
    });
    expect((await reload(access.event.id)).coverRevision).toBe(0);
    expect((await reload(access.event.id)).coverObjectKey).toBe(legacyKey(access.event.id));
    expect(await testEnv.DB.prepare(`
      SELECT status, retryable, failure_code, dispatch_state
      FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?
    `).bind(access.event.id, OPERATION).first()).toEqual({
      status: 'failed', retryable: 0, failure_code: 'EVENT_DELETED', dispatch_state: 'blocked',
    });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
  });

  it('writes no retirement row when it loses its revision guard', async () => {
    await seedPendingRemoval();
    await testEnv.DB.prepare('UPDATE events SET cover_revision = 4 WHERE id = ?')
      .bind(access.event.id).run();

    const outcome = await applyRemovalPublication(testEnv, {
      event: { ...await reload(access.event.id), coverRevision: 0 },
      operationId: OPERATION, requestDigest: HEX_64, expectedRevision: 0, now,
    });
    expect(outcome).toMatchObject({
      applied: false,
      appliedRevision: null,
      receipt: { status: 'conflict' },
      view: { status: 'conflict' },
    });

    const retired = await testEnv.DB.prepare(
      'SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?',
    ).bind(access.event.id).first<{ count: number }>();
    expect(retired).toEqual({ count: 0 });
    // The winning cover is untouched, and the losing receipt is recorded.
    expect((await reload(access.event.id)).coverObjectKey).toBe(legacyKey(access.event.id));
    const receipt = await testEnv.DB.prepare(
      'SELECT status FROM event_cover_publish_receipts WHERE operation_id = ?',
    ).bind(OPERATION).first();
    expect(receipt).toEqual({ status: 'conflict' });
  });

  it('does not claim another publication that reached the same next revision', async () => {
    const staleEvent = await seedPendingRemoval();
    const winningKey = `events/${access.event.id}/cover/winner.jpg`;
    await testEnv.DB.prepare(`
      UPDATE events SET cover_revision = 1, cover_object_key = ? WHERE id = ?
    `).bind(winningKey, access.event.id).run();

    const outcome = await applyRemovalPublication(testEnv, {
      event: staleEvent,
      operationId: OPERATION, requestDigest: HEX_64, expectedRevision: 0, now,
    });
    expect(outcome).toMatchObject({
      applied: false,
      appliedRevision: null,
      receipt: { status: 'conflict' },
      view: { status: 'conflict' },
    });

    expect((await reload(access.event.id)).coverObjectKey).toBe(winningKey);
    expect(await testEnv.DB.prepare(`
      SELECT status, applied_revision FROM event_cover_publish_receipts
      WHERE event_id = ? AND operation_id = ?
    `).bind(access.event.id, OPERATION).first()).toEqual({
      status: 'conflict', applied_revision: null,
    });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
  });
});

describe('strict synchronous semantic publications', () => {
  let access: Access;

  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('pins the exact preset config, nulls owned pointers, and replays one applied revision', async () => {
    const first = await applySemanticForTest(access, presetRequest());

    expect(first).toMatchObject({
      receipt: {
        action: 'publish',
        status: 'applied',
        applied_revision: 1,
        result_cover_json: JSON.stringify({
          version: 1,
          source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
          effect: 'film',
        }),
        draft_id: null,
        render_set_id: null,
        workflow_instance_id: null,
      },
      view: { status: 'applied' },
      event: {
        coverConfig: JSON.stringify({
          version: 1,
          source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
          effect: 'film',
        }),
        coverObjectKey: null,
        coverRenderSetId: null,
        coverRevision: 1,
      },
    });
    expect(await reload(access.event.id)).toMatchObject({
      coverConfig: JSON.stringify({
        version: 1,
        source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
        effect: 'film',
      }),
      coverObjectKey: null,
      coverRenderSetId: null,
      coverRevision: 1,
    });

    const replay = await applySemanticForTest(access, presetRequest());
    expect(replay).toMatchObject({
      receipt: { status: 'applied', applied_revision: 1 },
      view: { status: 'applied' },
    });
    expect((await reload(access.event.id)).coverRevision).toBe(1);

    await expect(applySemanticForTest(access, presetRequest(), OTHER_HEX))
      .rejects.toMatchObject({ code: 'COVER_PUBLICATION_CONFLICT', status: 409 });
  });

  it('records a first-seen stale preset as conflict without allocating or mutating', async () => {
    await moveEventToCompetingPreset(access.event.id);

    const outcome = await applySemanticForTest(access, presetRequest());

    expect(outcome).toMatchObject({
      receipt: {
        action: 'publish',
        status: 'conflict',
        draft_id: null,
        render_set_id: null,
        workflow_instance_id: null,
      },
      view: { status: 'conflict' },
    });
    expect(await reload(access.event.id)).toMatchObject({
      coverRevision: 1,
      coverObjectKey: null,
      coverRenderSetId: null,
    });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_render_sets WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
  });

  it('records conflict when a competing publication already retired the stale uploaded predecessor', async () => {
    const active = await seedActiveUploadCover(access);
    const staleEvent = await reload(access.event.id);
    const winnerConfig = JSON.stringify({
      version: 1,
      source: { kind: 'preset', presetId: 'pressed-paper', assetVersion: 1 },
      effect: 'natural',
    });
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE events SET cover_config = ?, cover_object_key = NULL,
          cover_render_set_id = NULL, cover_revision = 2
        WHERE id = ?
      `).bind(winnerConfig, access.event.id),
      testEnv.DB.prepare(`
        UPDATE event_cover_render_sets
        SET state = 'retired', retired_at = ?, cleanup_after = ?
        WHERE id = ?
      `).bind(now.toISOString(), '2026-08-11T12:00:00.000Z', active.setId),
      testEnv.DB.prepare(`
        UPDATE event_cover_masters SET cleanup_after = ? WHERE id = ?
      `).bind('2026-08-11T12:00:00.000Z', active.masterId),
    ]);

    const outcome = await applySemanticCoverPublication(testEnv, {
      event: staleEvent,
      request: presetRequest({ expectedRevision: 1 }),
      requestDigest: HEX_64,
      now,
    });

    expect(outcome).toMatchObject({
      applied: false,
      appliedRevision: null,
      receipt: { status: 'conflict' },
      event: {
        coverConfig: winnerConfig,
        coverRevision: 2,
        coverObjectKey: null,
        coverRenderSetId: null,
      },
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, cleanup_after FROM event_cover_render_sets WHERE id = ?
    `).bind(active.setId).first()).toEqual({
      state: 'retired', cleanup_after: '2026-08-11T12:00:00.000Z',
    });
    expect(await testEnv.DB.prepare(`
      SELECT cleanup_after FROM event_cover_masters WHERE id = ?
    `).bind(active.masterId).first()).toEqual({ cleanup_after: '2026-08-11T12:00:00.000Z' });
  });

  it('classifies a mismatched removal receipt before a preset can use its guard', async () => {
    const timestamp = now.toISOString();
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (
        event_id, operation_id, request_sha256, action, expected_revision, status,
        dependency_versions_json, completed_profiles, required_profiles, retryable,
        dispatch_state, dispatch_generation, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, 'remove', 0, 'conflict', '{}', 0, 0, 0,
        'pending', 0, ?, ?, ?)
    `).bind(
      access.event.id,
      OPERATION,
      HEX_64,
      timestamp,
      timestamp,
      '2026-08-05T12:00:00.000Z',
    ).run();

    await expect(applySemanticForTest(access, presetRequest()))
      .rejects.toMatchObject({ code: 'COVER_PUBLICATION_CONFLICT', status: 409 });
    expect(await reload(access.event.id)).toMatchObject({
      coverRevision: 0,
      coverObjectKey: null,
      coverRenderSetId: null,
    });
  });

  it('returns a terminal replay before inspecting or allocating publication owners', async () => {
    await applySemanticForTest(access, presetRequest());
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('SELECT s.master_id')
              || sql.includes('INSERT INTO event_cover_publish_receipts')
              || sql.includes('UPDATE events SET')) {
              throw new Error('terminal replay allocated or mutated');
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const replay = await applySemanticForTest(
      access,
      presetRequest(),
      HEX_64,
      { ...testEnv, DB: db },
    );

    expect(replay).toMatchObject({
      applied: true,
      appliedRevision: 1,
      receipt: { status: 'applied' },
    });
    expect((await reload(access.event.id)).coverRevision).toBe(1);
  });

  it.each([
    ['preset', presetRequest()],
    ['removal', noneRequest()],
  ])('retires a displaced normalized upload for %s at the receipt retention floor', async (
    _name,
    request,
  ) => {
    const retainedUntil = '2026-08-20T12:00:00.000Z';
    const active = await seedActiveUploadCover(access, { receiptExpiry: retainedUntil });

    const outcome = await applySemanticForTest(access, {
      ...request,
      expectedRevision: 1,
    });

    expect(outcome.receipt.status).toBe('applied');
    const event = await reload(access.event.id);
    expect(event.coverRevision).toBe(2);
    expect(event.coverObjectKey).toBeNull();
    expect(event.coverRenderSetId).toBeNull();
    const set = await testEnv.DB.prepare(`
      SELECT state, retired_at, cleanup_after FROM event_cover_render_sets WHERE id = ?
    `).bind(active.setId).first();
    expect(set).toEqual({
      state: 'retired',
      retired_at: now.toISOString(),
      cleanup_after: retainedUntil,
    });
    expect(await testEnv.DB.prepare(`
      SELECT cleanup_after FROM event_cover_masters WHERE id = ?
    `).bind(active.masterId).first()).toEqual({ cleanup_after: retainedUntil });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
    expect(await testEnv.MEDIA_BUCKET.head(active.objectKey)).not.toBeNull();
  });

  it('schedules no master when preset and none predecessors own no event bytes', async () => {
    await applySemanticForTest(access, presetRequest());
    const second = noneRequest({
      operationId: 'c7f70915-e746-41a6-9e59-fc2b8812550a',
      expectedRevision: 1,
    });
    await applySemanticForTest(access, second, OTHER_HEX);

    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_masters WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
  });

  it.each([
    ['applied receipt', "SET status = 'applied', applied_revision"],
    ['set retirement', "SET state = 'retired', retired_at"],
    ['master retention', 'UPDATE event_cover_masters'],
  ])('rolls the entire winning graph back when the %s tail changes zero rows', async (
    _name,
    fragment,
  ) => {
    const active = await seedActiveUploadCover(access, {
      receiptExpiry: '2026-08-20T12:00:00.000Z',
    });
    const beforeEvent = await testEnv.DB.prepare('SELECT * FROM events WHERE id = ?')
      .bind(access.event.id).first();
    const beforeSet = await testEnv.DB.prepare('SELECT * FROM event_cover_render_sets WHERE id = ?')
      .bind(active.setId).first();
    const beforeMaster = await testEnv.DB.prepare('SELECT * FROM event_cover_masters WHERE id = ?')
      .bind(active.masterId).first();
    const fault = zeroSemanticTailDb(fragment);

    await expect(applySemanticForTest(
      access,
      presetRequest({ expectedRevision: 1 }),
      HEX_64,
      { ...testEnv, DB: fault.db },
    )).rejects.toThrow();

    expect(fault.wasInjected()).toBe(true);
    expect(await testEnv.DB.prepare('SELECT * FROM events WHERE id = ?')
      .bind(access.event.id).first()).toEqual(beforeEvent);
    expect(await testEnv.DB.prepare('SELECT * FROM event_cover_render_sets WHERE id = ?')
      .bind(active.setId).first()).toEqual(beforeSet);
    expect(await testEnv.DB.prepare('SELECT * FROM event_cover_masters WHERE id = ?')
      .bind(active.masterId).first()).toEqual(beforeMaster);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?
    `).bind(access.event.id, OPERATION).first()).toBeNull();
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0 });
  });

  it('rolls a zero-row conflict tail and its newly inserted receipt back together', async () => {
    await moveEventToCompetingPreset(access.event.id);
    const beforeEvent = await testEnv.DB.prepare('SELECT * FROM events WHERE id = ?')
      .bind(access.event.id).first();
    const fault = zeroSemanticTailDb("SET status = 'conflict'");

    await expect(applySemanticForTest(
      access,
      presetRequest(),
      HEX_64,
      { ...testEnv, DB: fault.db },
    )).rejects.toThrow();

    expect(fault.wasInjected()).toBe(true);
    expect(await testEnv.DB.prepare('SELECT * FROM events WHERE id = ?')
      .bind(access.event.id).first()).toEqual(beforeEvent);
    expect(await testEnv.DB.prepare(`
      SELECT * FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?
    `).bind(access.event.id, OPERATION).first()).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import { EVENT_COVER_PROFILES } from '../../shared/event-cover';
import { createCoverDraft, insertCoverMaster } from '../../worker/db/event-covers';
import { EventsRepository } from '../../worker/db/events';
import {
  acceptCoverPublication,
  restartCoverPublication,
} from '../../worker/services/event-cover-publication';
import { coverMasterKey } from '../../worker/storage/event-cover-keys';
import {
  cleanupEventCovers,
  reconcileEventCoverPurge,
  type CoverPurgeWorkflowAccessors,
} from '../../worker/workflows/cleanup';
import {
  coverRenderFinalize,
  coverRenderPreflight,
  coverRenderProfileStep,
  deriveCoverSlots,
} from '../../worker/workflows/cover-render';
import { eventAccess, resetDatabase, testEnv, withRecordingImages } from './helpers';
import type { AppEnv } from '../../worker/env';

const now = new Date('2026-08-04T12:00:00.000Z');
const HEX_64 = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);
const OPERATION = '5f3a2b18-6c2d-4f0e-9a71-0c2d1e8b4a55';
const FENCE_HOLD = '9999-12-31T23:59:59.999Z';
const SMALL_MANIFEST_JSON = JSON.stringify({
  slots: [
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
  ],
});
const COMPETING_PRESET_CONFIG = JSON.stringify({
  version: 1,
  source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
  effect: 'natural',
});

type Access = Awaited<ReturnType<typeof eventAccess>>;

async function moveEventToCompetingPreset(eventId: string, revision: number): Promise<void> {
  await testEnv.DB.prepare(`
    UPDATE events
    SET cover_config = ?, cover_object_key = NULL, cover_render_set_id = NULL,
        cover_revision = ?
    WHERE id = ?
  `).bind(COMPETING_PRESET_CONFIG, revision, eventId).run();
}

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

/** Small enough that every slot lands inside its own byte ceiling. */
function renderEnv(): AppEnv {
  return withRecordingImages({ encode: () => ({
    bytes: new Uint8Array(20_000).fill(2), width: 0, height: 0, contentType: 'image/webp',
  }) }).env;
}

async function publication(access: Access, master: { width: number; height: number }) {
  await insertCoverMaster(testEnv.DB, {
    id: 'master-a',
    eventId: access.event.id,
    objectKey: coverMasterKey(access.event.id, 'master-a'),
    byteSize: 900_000, width: master.width, height: master.height, sha256: HEX_64,
    normalizationVersion: 1, normalizationRung: 1, now,
  });
  await testEnv.DB.prepare(`
    UPDATE event_cover_masters SET auto_focus_x = 0.5, auto_focus_y = 0.5,
      composition_model_version = 1 WHERE id = 'master-a'
  `).run();
  await testEnv.MEDIA_BUCKET.put(coverMasterKey(access.event.id, 'master-a'), new Uint8Array(2_000));

  const draft = (await createCoverDraft(testEnv.DB, {
    eventId: access.event.id, draftIntentId: 'intent-a', requestDigest: HEX_64,
    source: 'existing_upload', masterId: 'master-a', now,
  })).draft;
  const event = (await new EventsRepository(testEnv.DB).getById(access.event.id))!;
  const accepted = await acceptCoverPublication(testEnv, {
    event,
    request: {
      operationId: OPERATION, expectedRevision: event.coverRevision,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' }, effect: 'natural',
    },
    requestDigest: HEX_64,
    now,
  });
  return { draft, receipt: accepted.receipt };
}

async function seedActiveUploadCover(access: Access, receiptExpiry: string) {
  const masterId = 'master-active';
  const setId = 'set-active';
  const objectKey = coverMasterKey(access.event.id, masterId);
  const timestamp = now.toISOString();
  await insertCoverMaster(testEnv.DB, {
    id: masterId, eventId: access.event.id, objectKey,
    byteSize: 900_000, width: 2480, height: 1680, sha256: OTHER_HEX,
    normalizationVersion: 1, normalizationRung: 1, now,
  });
  await testEnv.MEDIA_BUCKET.put(objectKey, new Uint8Array([4, 5, 6]));
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_render_sets (
      id, event_id, master_id, recipe_json, recipe_sha256, state,
      required_slots, created_at
    ) VALUES (?, ?, ?, ?, ?, 'staging', 12, ?)
  `).bind(
    setId, access.event.id, masterId,
    '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
    OTHER_HEX, timestamp,
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
  `).bind(HEX_64, timestamp, timestamp, setId).run();
  await testEnv.DB.prepare(`
    UPDATE events SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?,
      cover_revision = 1 WHERE id = ?
  `).bind(
    '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
    objectKey, setId, access.event.id,
  ).run();
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_publish_receipts (
      event_id, operation_id, render_set_id, request_sha256, action,
      expected_revision, status, dependency_versions_json, completed_profiles,
      required_profiles, applied_revision, result_cover_json, retryable,
      dispatch_state, dispatch_generation, created_at, updated_at, expires_at
    ) VALUES (?, 'old-upload-operation', ?, ?, 'publish', 0, 'applied', '{}',
      6, 6, 1, ?, 0, 'confirmed', 0, ?, ?, ?)
  `).bind(
    access.event.id, setId, OTHER_HEX,
    '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
    timestamp, timestamp, receiptExpiry,
  ).run();
  return { masterId, setId, objectKey };
}

it('keeps a legacy-expired active render fence so a later profile write remains fenced', async () => {
  await resetDatabase();
  const access = await eventAccess();
  const created = new Date('2026-06-01T12:00:00.000Z');
  await insertCoverMaster(testEnv.DB, {
    id: 'master-old', eventId: access.event.id,
    objectKey: coverMasterKey(access.event.id, 'master-old'),
    byteSize: 900_000, width: 2480, height: 1680, sha256: HEX_64,
    normalizationVersion: 1, normalizationRung: 1, now: created,
  });
  await testEnv.DB.prepare(`
    UPDATE event_cover_masters SET auto_focus_x = 0.5, auto_focus_y = 0.5,
      composition_model_version = 1 WHERE id = 'master-old'
  `).run();
  await testEnv.MEDIA_BUCKET.put(
    coverMasterKey(access.event.id, 'master-old'), new Uint8Array(2_000),
  );
  const draft = (await createCoverDraft(testEnv.DB, {
    eventId: access.event.id, draftIntentId: 'intent-old', requestDigest: HEX_64,
    source: 'existing_upload', masterId: 'master-old', now: created,
  })).draft;
  const event = (await new EventsRepository(testEnv.DB).getById(access.event.id))!;
  const accepted = await acceptCoverPublication(testEnv, {
    event,
    request: {
      operationId: OPERATION, expectedRevision: event.coverRevision,
      source: { kind: 'upload', draftId: draft.id }, focus: { mode: 'auto' }, effect: 'natural',
    },
    requestDigest: HEX_64,
    now: created,
  });

  expect(await row('SELECT expires_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
    accepted.receipt.workflow_instance_id)).toEqual({ expires_at: FENCE_HOLD });
  const env = renderEnv();
  await coverRenderPreflight(env, { eventId: access.event.id, operationId: OPERATION }, created);
  const legacyExpiry = new Date(created.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString();
  await testEnv.DB.prepare(`
    UPDATE event_cover_workflow_fences SET expires_at = ? WHERE workflow_instance_id = ?
  `).bind(legacyExpiry, accepted.receipt.workflow_instance_id).run();
  const sweepAt = new Date(created.getTime() + 32 * 24 * 60 * 60 * 1000);

  await cleanupEventCovers(testEnv, sweepAt);

  expect(await row('SELECT expires_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
    accepted.receipt.workflow_instance_id)).toEqual({ expires_at: legacyExpiry });
  const rendered = await coverRenderProfileStep(
    env, { eventId: access.event.id, operationId: OPERATION }, EVENT_COVER_PROFILES[0]!.id, sweepAt,
  );
  expect(rendered.written).toBeGreaterThan(0);
});

it('restores the hold when a terminal render receipt is claimed for retry', async () => {
  await resetDatabase();
  const access = await eventAccess();
  const { receipt } = await publication(access, { width: 2480, height: 1680 });
  await testEnv.DB.batch([
    testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 1, updated_at = ?
      WHERE event_id = ? AND operation_id = ?
    `).bind(new Date(now.getTime() - 60_000).toISOString(), access.event.id, OPERATION),
    testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences SET expires_at = ?
      WHERE workflow_instance_id = ?
    `).bind('2026-09-04T12:00:00.000Z', receipt.workflow_instance_id),
  ]);
  const workflow = {
    async lookup() { return { kind: 'status' as const, status: 'errored' }; },
    async create() { throw new Error('unreachable'); },
    async resume() { throw new Error('unreachable'); },
    async restart() {},
    async terminate() { throw new Error('unreachable'); },
  };

  expect(await restartCoverPublication(testEnv, {
    eventId: access.event.id, operationId: OPERATION, now, workflow,
  })).toMatchObject({ status: 'restarted' });
  expect(await row('SELECT expires_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
    receipt.workflow_instance_id)).toEqual({ expires_at: FENCE_HOLD });
});

async function runEveryProfile(env: AppEnv, eventId: string) {
  for (const profile of EVENT_COVER_PROFILES) {
    await coverRenderProfileStep(env, { eventId, operationId: OPERATION }, profile.id, now);
  }
}

async function row<T>(sql: string, ...binds: unknown[]): Promise<T> {
  return (await testEnv.DB.prepare(sql).bind(...binds).first<T>())!;
}

async function testSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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

function zeroRenderTailEnv(fragment: string): { env: AppEnv; wasInjected: () => boolean } {
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

function envRejectingManifestReads(): AppEnv {
  const bucket = new Proxy(testEnv.MEDIA_BUCKET, {
    get(target, property) {
      if (property === 'get') {
        return async () => { throw new Error('ready checkpoint must be reused'); };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...testEnv, MEDIA_BUCKET: bucket };
}

function envOnFirstObjectRead(action: () => Promise<void>): AppEnv {
  let acted = false;
  const bucket = new Proxy(testEnv.MEDIA_BUCKET, {
    get(target, property) {
      if (property === 'get') {
        return async (key: string) => {
          if (!acted) {
            acted = true;
            await action();
            return null;
          }
          return target.get(key);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...testEnv, MEDIA_BUCKET: bucket };
}

describe('derived slot manifest', () => {
  it('requires both 1x formats for all six profiles and adds only qualified 2x pairs', () => {
    const auto = { mode: 'auto' } as const;
    const small = deriveCoverSlots(
      { width: 620, height: 420, auto_focus_x: 0.5, auto_focus_y: 0.5 }, auto,
    );
    expect(small).toHaveLength(12);
    expect(small.every((slot) => slot.density === '1x')).toBe(true);

    const large = deriveCoverSlots(
      { width: 1240, height: 840, auto_focus_x: 0.5, auto_focus_y: 0.5 }, auto,
    );
    expect(large).toHaveLength(24);

    // A manual zoom removes 2x profiles but can never invalidate a 1x one.
    const zoomed = deriveCoverSlots(
      { width: 1240, height: 840, auto_focus_x: 0.5, auto_focus_y: 0.5 },
      { mode: 'manual', x: 0.5, y: 0.5, zoom: 2 },
    );
    expect(zoomed).toHaveLength(12);
    expect(zoomed.filter((slot) => slot.density === '1x')).toHaveLength(12);

    // Partial eligibility lands strictly between the bounds.
    const partial = deriveCoverSlots(
      { width: 1240, height: 600, auto_focus_x: 0.5, auto_focus_y: 0.5 }, auto,
    );
    expect(partial.length).toBeGreaterThan(12);
    expect(partial.length).toBeLessThan(24);
  });
});

describe('cover render preflight', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('freezes the derived manifest and moves the receipt to rendering', async () => {
    await publication(access, { width: 2480, height: 1680 });
    const preflight = await coverRenderPreflight(renderEnv(), {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(preflight.shouldRender).toBe(true);
    expect(preflight.slots).toHaveLength(24);
    expect(await row('SELECT status FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual({ status: 'rendering' });
    expect(await row('SELECT required_slots FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ required_slots: 24 });
  });

  it.each([
    ['applied', null, 7],
    ['failed', 'EVENT_DELETED', null],
  ] as const)(
    'returns the exact durable %s outcome on a terminal replay',
    async (status, failureCode, appliedRevision) => {
      await publication(access, { width: 2480, height: 1680 });
      await testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = ?, retryable = ?, failure_code = ?, applied_revision = ?
        WHERE operation_id = ?
      `).bind(status, 0, failureCode, appliedRevision, OPERATION).run();

      const preflight = await coverRenderPreflight(renderEnv(), {
        eventId: access.event.id, operationId: OPERATION,
      }, now);

      expect(preflight).toMatchObject({
        shouldRender: false,
        outcome: {
          status,
          appliedRevision,
          failureCode,
          retryable: false,
        },
      });
    },
  );

  it('does not enter rendering when the event revision moves before the preflight batch', async () => {
    await publication(access, { width: 2480, height: 1680 });
    const beforeReceipt = await row('SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION);
    const beforeSet = await row('SELECT * FROM event_cover_render_sets WHERE event_id = ?', access.event.id);
    const raced = envBeforeFirstBatch(async () => {
      await moveEventToCompetingPreset(access.event.id, 1);
    });

    const preflight = await coverRenderPreflight(raced, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(preflight.shouldRender).toBe(false);
    expect(preflight.outcome.status).toBe('skipped');
    expect(await row('SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual(beforeReceipt);
    expect(await row('SELECT * FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual(beforeSet);
  });

  it('does not let an old preflight advance a newer dispatch generation', async () => {
    await publication(access, { width: 2480, height: 1680 });
    const raced = envBeforeFirstBatch(async () => {
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts
          SET dispatch_state = 'restarting', dispatch_generation = dispatch_generation + 1
          WHERE operation_id = ?
        `).bind(OPERATION),
        testEnv.DB.prepare(`
          UPDATE event_cover_workflow_fences
          SET dispatch_generation = dispatch_generation + 1
          WHERE event_id = ?
        `).bind(access.event.id),
      ]);
    });

    const preflight = await coverRenderPreflight(raced, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(preflight.shouldRender).toBe(false);
    expect(preflight.outcome.status).toBe('skipped');
    expect(await row(`
      SELECT status, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `, OPERATION)).toEqual({
      status: 'queued', dispatch_state: 'restarting', dispatch_generation: 1,
    });
    expect(await row('SELECT dispatch_generation FROM event_cover_workflow_fences WHERE event_id = ?', access.event.id))
      .toEqual({ dispatch_generation: 1 });
  });

  it('returns the terminal deletion that wins before the preflight batch', async () => {
    await publication(access, { width: 2480, height: 1680 });
    const raced = envBeforeFirstBatch(async () => {
      await testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED'
        WHERE operation_id = ?
      `).bind(OPERATION).run();
    });

    const preflight = await coverRenderPreflight(raced, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(preflight).toMatchObject({
      shouldRender: false,
      outcome: { status: 'failed', failureCode: 'EVENT_DELETED', retryable: false },
    });
  });

  it('records a conflict for a known-stale event without transforming anything', async () => {
    await publication(access, { width: 2480, height: 1680 });
    const { draft } = await row<{ draft: string }>(
      'SELECT draft_id AS draft FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION,
    );
    await moveEventToCompetingPreset(access.event.id, 1);

    const recording = withRecordingImages();
    const preflight = await coverRenderPreflight(recording.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(preflight.shouldRender).toBe(false);
    expect(preflight.outcome.status).toBe('conflict');
    expect(recording.calls).toHaveLength(0);
    expect(await row('SELECT status FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual({ status: 'conflict' });
    // The set is abandoned and the still-valid draft returns to `ready`, which
    // is what releases publication ownership so the host can republish.
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft))
      .toEqual({ state: 'ready' });
  });

  it('exits before any work when the purge coordinator blocked the fence', async () => {
    const { receipt } = await publication(access, { width: 2480, height: 1680 });
    // Through the production coordinator, not a hand-written state: an
    // `unknown` platform reading leaves the purge parked in its fence phase,
    // which is exactly the window a late dispatcher would arrive in.
    const purge = await reconcileEventCoverPurge(testEnv, access.event.id, now, blockingAccessors());
    expect(purge).toMatchObject({ phase: 'fences', remainder: true });
    expect(await row('SELECT state FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
      receipt.workflow_instance_id)).toEqual({ state: 'deletion-blocked' });

    const recording = withRecordingImages();
    const preflight = await coverRenderPreflight(recording.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    // Two independent barriers, and the receipt is the earlier one: the same
    // coordinator batch that blocked the fence also made this receipt terminal,
    // so the instance exits before it even reads the fence. The fence is what
    // catches an instance whose row is still live, which the two cases below
    // cover directly.
    expect(preflight.outcome.status).toBe('failed');
    expect(recording.calls).toHaveLength(0);
  });

  it('refuses to work when no fence exists at all, and gives the draft back', async () => {
    const { draft, receipt } = await publication(access, { width: 2480, height: 1680 });
    // A settled purge deletes the fence on its own 31-day schedule. Absence is
    // what an instance that outlived its fence sees, and it is refusal: the
    // earlier guard asked only whether a fence objected, so no row read as
    // consent and let a late instance write into a swept prefix.
    await testEnv.DB.prepare('DELETE FROM event_cover_workflow_fences WHERE workflow_instance_id = ?')
      .bind(receipt.workflow_instance_id).run();

    const recording = withRecordingImages();
    const preflight = await coverRenderPreflight(recording.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(preflight.outcome).toMatchObject({ status: 'failed', failureCode: 'COVER_RENDER_UNAVAILABLE' });
    expect(recording.calls).toHaveLength(0);
    // A permanent refusal has to release publication ownership with it.
    // `publishing` is not expirable, cannot be discarded, and cannot be failed,
    // so a draft left in it is stranded for the life of the event — and three of
    // them exhaust the per-event live-draft cap.
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'ready' });
  });

  /**
   * Supersession is not failure. `restartCoverPublication` bumps the receipt and
   * the fence in one batch, so a generation the instance did not claim means
   * another generation owns this receipt now — and the earlier form stamped a
   * *permanent* failure over it, which the live run then exits on. Nothing here
   * may be written by the run that lost.
   */
  it('writes nothing at all for a fence from another dispatch generation', async () => {
    const { draft, receipt } = await publication(access, { width: 2480, height: 1680 });
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET dispatch_generation = dispatch_generation + 1 WHERE workflow_instance_id = ?
    `).bind(receipt.workflow_instance_id).run();
    const before = await row('SELECT status, retryable, failure_code FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION);

    const recording = withRecordingImages();
    const preflight = await coverRenderPreflight(recording.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(preflight.shouldRender).toBe(false);
    expect(preflight.outcome.status).toBe('skipped');
    expect(recording.calls).toHaveLength(0);
    // The receipt still belongs to the generation that owns it, and the draft
    // and set stay exactly as that generation left them.
    expect(await row('SELECT status, retryable, failure_code FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual(before);
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'publishing' });
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'staging' });
  });

  it('gives the draft back when the stored recipe cannot be read', async () => {
    const { draft } = await publication(access, { width: 2480, height: 1680 });
    await testEnv.DB.prepare("UPDATE event_cover_render_sets SET recipe_json = '{}' WHERE event_id = ?")
      .bind(access.event.id).run();

    const recording = withRecordingImages();
    const preflight = await coverRenderPreflight(recording.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(preflight.outcome).toMatchObject({ status: 'failed', failureCode: 'COVER_RENDER_UNAVAILABLE' });
    expect(recording.calls).toHaveLength(0);
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'ready' });
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
  });

  it('records a safe failure for a deleted event', async () => {
    await publication(access, { width: 2480, height: 1680 });
    await testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
      .bind(now.toISOString(), access.event.id).run();

    const recording = withRecordingImages();
    const preflight = await coverRenderPreflight(recording.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);
    expect(preflight.outcome.status).toBe('failed');
    expect(recording.calls).toHaveLength(0);
  });
});

describe('cover render profile steps', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
    await publication(access, { width: 2480, height: 1680 });
    expect((await coverRenderPreflight(
      renderEnv(), { eventId: access.event.id, operationId: OPERATION }, now,
    )).shouldRender).toBe(true);
  });

  it('is individually replay-safe: a second run adopts rather than rewrites', async () => {
    const first = withRecordingImages({ encode: () => ({
      bytes: new Uint8Array(20_000).fill(2), width: 0, height: 0, contentType: 'image/webp',
    }) });
    const one = await coverRenderProfileStep(first.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, 'wide-expanded', now);
    expect(one).toMatchObject({ profile: 'wide-expanded', written: 4, adopted: 0 });

    const second = withRecordingImages();
    const two = await coverRenderProfileStep(second.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, 'wide-expanded', now);
    expect(two).toMatchObject({ written: 0, adopted: 4 });
    expect(second.calls).toHaveLength(0);

    // The compound slot key makes a duplicate row unrepresentable.
    const objects = await row<{ count: number }>(`
      SELECT count(*) AS count FROM event_cover_render_objects WHERE profile_id = 'wide-expanded'
    `);
    expect(objects).toEqual({ count: 4 });
  });

  it('reports durable progress from inventory, never from elapsed time', async () => {
    const env = renderEnv();
    const seen: number[] = [];
    for (const profile of EVENT_COVER_PROFILES) {
      const summary = await coverRenderProfileStep(env, {
        eventId: access.event.id, operationId: OPERATION,
      }, profile.id, now);
      seen.push(summary.completedProfiles);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await row('SELECT completed_profiles FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual({ completed_profiles: 6 });
  });
});

describe('cover render finalize', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  async function prepared(
    _withLegacyCover = false,
    master: { width: number; height: number } = { width: 2480, height: 1680 },
  ) {
    void _withLegacyCover;
    const result = await publication(access, master);
    const env = renderEnv();
    await coverRenderPreflight(env, { eventId: access.event.id, operationId: OPERATION }, now);
    await runEveryProfile(env, access.event.id);
    return result;
  }

  it('commits the pointer, set transition, draft, receipt, and fence together', async () => {
    const { draft } = await prepared(false);
    const finalizedAt = new Date('2026-08-11T12:00:00.000Z');
    const outcome = await coverRenderFinalize(testEnv, {
      eventId: access.event.id, operationId: OPERATION,
    }, finalizedAt);

    expect(outcome).toMatchObject({ status: 'applied', appliedRevision: 1 });
    const event = (await new EventsRepository(testEnv.DB).getById(access.event.id))!;
    expect(event.coverRevision).toBe(1);
    expect(event.coverObjectKey).toBe(coverMasterKey(access.event.id, 'master-a'));
    expect(event.coverRenderSetId).toBe(
      (await row<{ id: string }>('SELECT id FROM event_cover_render_sets WHERE event_id = ?', access.event.id)).id,
    );
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'active' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'published' });
    expect(await row('SELECT status, applied_revision FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual({ status: 'applied', applied_revision: 1 });
    expect(await row('SELECT expires_at FROM event_cover_workflow_fences WHERE event_id = ?', access.event.id))
      .toEqual({ expires_at: '2026-09-11T12:00:00.000Z' });

    expect(await row('SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?', access.event.id))
      .toEqual({ count: 0 });
  });

  it('stores the SHA-256 of the exact derived manifest rather than the recipe', async () => {
    await prepared(false, { width: 620, height: 420 });

    expect(await coverRenderFinalize(testEnv, {
      eventId: access.event.id, operationId: OPERATION,
    }, now)).toMatchObject({ status: 'applied' });

    const set = await row<{ manifest_sha256: string; recipe_sha256: string }>(`
      SELECT manifest_sha256, recipe_sha256
      FROM event_cover_render_sets WHERE event_id = ?
    `, access.event.id);
    expect(set.manifest_sha256).toBe(await testSha256(SMALL_MANIFEST_JSON));
    expect(set.manifest_sha256).not.toBe(set.recipe_sha256);
  });

  it('persists and reuses the ready/finalizing checkpoint before the pointer swap', async () => {
    const { draft, receipt } = await prepared(false, { width: 620, height: 420 });
    const paused = envAfterFirstBatch(async () => {
      throw new Error('pause after ready checkpoint');
    });

    await expect(coverRenderFinalize(paused, {
      eventId: access.event.id, operationId: OPERATION,
    }, now)).rejects.toThrow('pause after ready checkpoint');

    expect(await row(`
      SELECT state, manifest_sha256, ready_at, published_revision, published_at
      FROM event_cover_render_sets WHERE id = ?
    `, receipt.render_set_id)).toEqual({
      state: 'ready',
      manifest_sha256: await testSha256(SMALL_MANIFEST_JSON),
      ready_at: now.toISOString(),
      published_revision: null,
      published_at: null,
    });
    expect(await row(`
      SELECT status, applied_revision, result_cover_json
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `, OPERATION)).toEqual({
      status: 'finalizing', applied_revision: null, result_cover_json: null,
    });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'publishing' });
    expect(await row(`
      SELECT cover_revision, cover_object_key, cover_render_set_id FROM events WHERE id = ?
    `, access.event.id)).toEqual({
      cover_revision: 0, cover_object_key: null, cover_render_set_id: null,
    });

    await expect(coverRenderFinalize(envRejectingManifestReads(), {
      eventId: access.event.id, operationId: OPERATION,
    }, now)).resolves.toMatchObject({ status: 'applied', appliedRevision: 1 });
  });

  it('settles one atomic conflict when the revision changes after the ready checkpoint', async () => {
    const { draft, receipt } = await prepared(false, { width: 620, height: 420 });
    const raced = envAfterFirstBatch(async () => {
      await moveEventToCompetingPreset(access.event.id, 1);
    });

    await expect(coverRenderFinalize(raced, {
      eventId: access.event.id, operationId: OPERATION,
    }, now)).resolves.toMatchObject({ status: 'conflict', appliedRevision: null });

    expect(await row(`
      SELECT cover_revision, cover_object_key, cover_render_set_id FROM events WHERE id = ?
    `, access.event.id)).toEqual({
      cover_revision: 1,
      cover_object_key: null,
      cover_render_set_id: null,
    });
    expect(await row(`
      SELECT status, applied_revision, result_cover_json FROM event_cover_publish_receipts
      WHERE operation_id = ?
    `, OPERATION)).toEqual({
      status: 'conflict', applied_revision: null, result_cover_json: null,
    });
    expect(await row(`
      SELECT state, manifest_sha256, ready_at, abandoned_reason
      FROM event_cover_render_sets WHERE id = ?
    `, receipt.render_set_id)).toEqual({
      state: 'abandoned',
      manifest_sha256: await testSha256(SMALL_MANIFEST_JSON),
      ready_at: now.toISOString(),
      abandoned_reason: 'revision-conflict',
    });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'ready' });
    expect(await row(`
      SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?
    `, access.event.id)).toEqual({ count: 0 });
    expect(await row('SELECT expires_at FROM event_cover_workflow_fences WHERE event_id = ?', access.event.id))
      .toEqual({ expires_at: '2026-09-04T12:00:00.000Z' });
  });

  it.each([
    ['applied receipt', "SET status = 'applied', applied_revision"],
    ['conflict receipt', "SET status = 'conflict'"],
  ])('rolls the complete final graph back when the %s tail changes zero rows', async (
    _name,
    fragment,
  ) => {
    const { draft, receipt } = await prepared(false, { width: 620, height: 420 });
    await expect(coverRenderFinalize(envAfterFirstBatch(async () => {
      throw new Error('checkpoint only');
    }), { eventId: access.event.id, operationId: OPERATION }, now))
      .rejects.toThrow('checkpoint only');
    if (fragment.includes('conflict')) {
      await moveEventToCompetingPreset(access.event.id, 1);
    }
    const beforeEvent = await row('SELECT * FROM events WHERE id = ?', access.event.id);
    const beforeSet = await row('SELECT * FROM event_cover_render_sets WHERE id = ?', receipt.render_set_id);
    const beforeDraft = await row('SELECT * FROM event_cover_drafts WHERE id = ?', draft.id);
    const beforeReceipt = await row('SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION);
    const fault = zeroRenderTailEnv(fragment);

    await expect(coverRenderFinalize(fault.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, now)).rejects.toThrow();

    expect(fault.wasInjected()).toBe(true);
    expect(await row('SELECT * FROM events WHERE id = ?', access.event.id)).toEqual(beforeEvent);
    expect(await row('SELECT * FROM event_cover_render_sets WHERE id = ?', receipt.render_set_id))
      .toEqual(beforeSet);
    expect(await row('SELECT * FROM event_cover_drafts WHERE id = ?', draft.id)).toEqual(beforeDraft);
    expect(await row('SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual(beforeReceipt);
  });

  it('retains a displaced normalized upload through the longest referencing receipt', async () => {
    const retainedUntil = '2026-08-20T12:00:00.000Z';
    const active = await seedActiveUploadCover(access, retainedUntil);
    await prepared(false, { width: 620, height: 420 });

    await expect(coverRenderFinalize(testEnv, {
      eventId: access.event.id, operationId: OPERATION,
    }, now)).resolves.toMatchObject({ status: 'applied', appliedRevision: 2 });

    expect(await row(`
      SELECT state, retired_at, cleanup_after FROM event_cover_render_sets WHERE id = ?
    `, active.setId)).toEqual({
      state: 'retired', retired_at: now.toISOString(), cleanup_after: retainedUntil,
    });
    expect(await row('SELECT cleanup_after FROM event_cover_masters WHERE id = ?', active.masterId))
      .toEqual({ cleanup_after: retainedUntil });
    expect(await row(`
      SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?
    `, access.event.id)).toEqual({ count: 0 });
    expect(await testEnv.MEDIA_BUCKET.head(active.objectKey)).not.toBeNull();
  });

  it.each([
    ['displaced set', "SET state = 'retired', retired_at"],
    ['displaced master', 'UPDATE event_cover_masters'],
  ])('rolls the upload-over-upload graph back when the %s tail changes zero rows', async (
    _name,
    fragment,
  ) => {
    const active = await seedActiveUploadCover(access, '2026-08-20T12:00:00.000Z');
    const { draft, receipt } = await prepared(false, { width: 620, height: 420 });
    await expect(coverRenderFinalize(envAfterFirstBatch(async () => {
      throw new Error('checkpoint only');
    }), { eventId: access.event.id, operationId: OPERATION }, now))
      .rejects.toThrow('checkpoint only');
    const beforeEvent = await row('SELECT * FROM events WHERE id = ?', access.event.id);
    const beforeOldSet = await row('SELECT * FROM event_cover_render_sets WHERE id = ?', active.setId);
    const beforeOldMaster = await row('SELECT * FROM event_cover_masters WHERE id = ?', active.masterId);
    const beforeNewSet = await row('SELECT * FROM event_cover_render_sets WHERE id = ?', receipt.render_set_id);
    const beforeDraft = await row('SELECT * FROM event_cover_drafts WHERE id = ?', draft.id);
    const beforeReceipt = await row('SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION);
    const fault = zeroRenderTailEnv(fragment);

    await expect(coverRenderFinalize(fault.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, now)).rejects.toThrow();

    expect(fault.wasInjected()).toBe(true);
    expect(await row('SELECT * FROM events WHERE id = ?', access.event.id)).toEqual(beforeEvent);
    expect(await row('SELECT * FROM event_cover_render_sets WHERE id = ?', active.setId))
      .toEqual(beforeOldSet);
    expect(await row('SELECT * FROM event_cover_masters WHERE id = ?', active.masterId))
      .toEqual(beforeOldMaster);
    expect(await row('SELECT * FROM event_cover_render_sets WHERE id = ?', receipt.render_set_id))
      .toEqual(beforeNewSet);
    expect(await row('SELECT * FROM event_cover_drafts WHERE id = ?', draft.id)).toEqual(beforeDraft);
    expect(await row('SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual(beforeReceipt);
  });

  it('refuses a count-preserving substitution outside the derived tuple set', async () => {
    const { draft } = await prepared(false, { width: 620, height: 420 });
    await testEnv.DB.prepare(`
      UPDATE event_cover_render_objects
      SET density = '2x', width = 720, height = 336
      WHERE profile_id = 'short-lookup' AND density = '1x' AND format = 'webp'
    `).run();

    const outcome = await coverRenderFinalize(testEnv, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(outcome).toMatchObject({ status: 'failed', retryable: false });
    expect((await new EventsRepository(testEnv.DB).getById(access.event.id))!.coverRenderSetId).toBeNull();
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'ready' });
  });

  it('is idempotent: a replayed finalize moves the revision exactly once', async () => {
    await prepared();
    await coverRenderFinalize(testEnv, { eventId: access.event.id, operationId: OPERATION }, now);
    const replay = await coverRenderFinalize(testEnv, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);
    expect(replay).toMatchObject({ status: 'applied', appliedRevision: 1 });
    expect((await new EventsRepository(testEnv.DB).getById(access.event.id))!.coverRevision).toBe(1);
  });

  it('records a conflict and touches no active pointer when the final guard loses', async () => {
    const { draft } = await prepared(false);
    await moveEventToCompetingPreset(access.event.id, 1);

    const outcome = await coverRenderFinalize(testEnv, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(outcome.status).toBe('conflict');
    const event = (await new EventsRepository(testEnv.DB).getById(access.event.id))!;
    expect(event.coverRevision).toBe(1);
    // The winning cover is untouched, and no retirement row was written.
    expect(event.coverObjectKey).toBeNull();
    expect(event.coverRenderSetId).toBeNull();
    expect(await row('SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?', access.event.id))
      .toEqual({ count: 0 });
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'ready' });
  });

  it('returns a permanent deletion that wins during manifest verification', async () => {
    const { draft } = await prepared();
    const set = await row<{ id: string }>(
      'SELECT id FROM event_cover_render_sets WHERE event_id = ?', access.event.id,
    );
    const raced = envOnFirstObjectRead(async () => {
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts
          SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED'
          WHERE operation_id = ?
        `).bind(OPERATION),
        testEnv.DB.prepare(`
          UPDATE event_cover_render_sets SET state = 'abandoned' WHERE id = ?
        `).bind(set.id),
        testEnv.DB.prepare(`
          UPDATE event_cover_drafts SET state = 'ready' WHERE id = ?
        `).bind(draft.id),
        testEnv.DB.prepare(`
          UPDATE event_cover_workflow_fences SET state = 'deletion-blocked'
          WHERE event_id = ?
        `).bind(access.event.id),
      ]);
    });

    const outcome = await coverRenderFinalize(raced, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(outcome).toEqual({
      status: 'failed', appliedRevision: null,
      failureCode: 'EVENT_DELETED', retryable: false,
    });
  });

  it('performs no Images or R2 work after deletion blocks the exact fence', async () => {
    await publication(access, { width: 2480, height: 1680 });
    expect((await coverRenderPreflight(
      renderEnv(), { eventId: access.event.id, operationId: OPERATION }, now,
    )).shouldRender).toBe(true);
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences SET state = 'deletion-blocked'
      WHERE event_id = ?
    `).bind(access.event.id).run();
    const recording = withRecordingImages({ encode: () => ({
      bytes: new Uint8Array(20_000).fill(2), width: 0, height: 0, contentType: 'image/webp',
    }) });

    const result = await coverRenderProfileStep(recording.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, 'wide-expanded', now);

    expect(result).toMatchObject({ written: 0, adopted: 0, completedProfiles: 0 });
    expect(recording.calls).toHaveLength(0);
    expect(await row('SELECT count(*) AS count FROM event_cover_render_objects WHERE event_id = ?', access.event.id))
      .toEqual({ count: 0 });
  });

  it('performs no Images or R2 work after the event revision moves on', async () => {
    await publication(access, { width: 2480, height: 1680 });
    expect((await coverRenderPreflight(
      renderEnv(), { eventId: access.event.id, operationId: OPERATION }, now,
    )).shouldRender).toBe(true);
    await moveEventToCompetingPreset(access.event.id, 1);
    const recording = withRecordingImages({ encode: () => ({
      bytes: new Uint8Array(20_000).fill(2), width: 0, height: 0, contentType: 'image/webp',
    }) });

    const result = await coverRenderProfileStep(recording.env, {
      eventId: access.event.id, operationId: OPERATION,
    }, 'wide-expanded', now);

    expect(result).toMatchObject({ written: 0, adopted: 0, completedProfiles: 0 });
    expect(recording.calls).toHaveLength(0);
  });

  it('cannot adopt a competing semantic publication that reached the same next revision', async () => {
    const { draft } = await prepared(false);
    const raced = envBeforeFirstBatch(async () => {
      await moveEventToCompetingPreset(access.event.id, 1);
    });

    const outcome = await coverRenderFinalize(raced, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(outcome.status).toBe('conflict');
    expect(await row(`
      SELECT cover_revision, cover_object_key, cover_render_set_id FROM events WHERE id = ?
    `, access.event.id)).toEqual({
      cover_revision: 1, cover_object_key: null, cover_render_set_id: null,
    });
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'ready' });
    expect(await row('SELECT status FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual({ status: 'conflict' });
  });

  it('cannot finalize after deletion already made the exact receipt permanently failed', async () => {
    const { draft } = await prepared();
    const set = await row<{ id: string }>(
      'SELECT id FROM event_cover_render_sets WHERE event_id = ?', access.event.id,
    );
    const raced = envBeforeFirstBatch(async () => {
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts
          SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED'
          WHERE operation_id = ?
        `).bind(OPERATION),
        testEnv.DB.prepare(`
          UPDATE event_cover_render_sets SET state = 'abandoned' WHERE id = ?
        `).bind(set.id),
        testEnv.DB.prepare(`
          UPDATE event_cover_drafts SET state = 'ready' WHERE id = ?
        `).bind(draft.id),
        testEnv.DB.prepare(`
          UPDATE event_cover_workflow_fences SET state = 'deletion-blocked'
          WHERE event_id = ?
        `).bind(access.event.id),
      ]);
    });

    const before = await row(`
      SELECT cover_revision, cover_object_key, cover_render_set_id FROM events WHERE id = ?
    `, access.event.id);
    const outcome = await coverRenderFinalize(raced, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(outcome.status).toBe('failed');
    expect(await row(`
      SELECT cover_revision, cover_object_key, cover_render_set_id FROM events WHERE id = ?
    `, access.event.id)).toEqual(before);
    expect(await row('SELECT state FROM event_cover_render_sets WHERE id = ?', set.id))
      .toEqual({ state: 'abandoned' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'ready' });
    expect(await row(`
      SELECT status, retryable, failure_code FROM event_cover_publish_receipts WHERE operation_id = ?
    `, OPERATION)).toEqual({ status: 'failed', retryable: 0, failure_code: 'EVENT_DELETED' });
  });

  it('does not let a lost-guard conflict writer overwrite a permanent deletion result', async () => {
    const { draft } = await prepared(false);
    const raced = envBeforeFirstBatch(async () => {
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE events
          SET cover_config = ?, cover_object_key = NULL, cover_render_set_id = NULL,
              cover_revision = 1
          WHERE id = ?
        `).bind(COMPETING_PRESET_CONFIG, access.event.id),
        testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts
          SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED'
          WHERE operation_id = ?
        `).bind(OPERATION),
      ]);
    });

    expect((await coverRenderFinalize(raced, {
      eventId: access.event.id, operationId: OPERATION,
    }, now)).status).toBe('failed');
    expect(await row(`
      SELECT status, retryable, failure_code FROM event_cover_publish_receipts WHERE operation_id = ?
    `, OPERATION)).toEqual({ status: 'failed', retryable: 0, failure_code: 'EVENT_DELETED' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'publishing' });
  });

  it('preserves a same-generation retryable failure that wins before finalize commits', async () => {
    const { draft } = await prepared();
    const set = await row<{ id: string }>(
      'SELECT id FROM event_cover_render_sets WHERE event_id = ?', access.event.id,
    );
    const raced = envBeforeFirstBatch(async () => {
      await testEnv.DB.prepare(`
        UPDATE event_cover_publish_receipts
        SET status = 'failed', retryable = 1,
            failure_code = 'COVER_RENDER_UNAVAILABLE', dispatch_state = 'failed'
        WHERE operation_id = ?
      `).bind(OPERATION).run();
    });

    expect(await coverRenderFinalize(raced, {
      eventId: access.event.id, operationId: OPERATION,
    }, now)).toMatchObject({
      status: 'failed', failureCode: 'COVER_RENDER_UNAVAILABLE', retryable: true,
    });
    expect(await row(`
      SELECT status, retryable, failure_code, dispatch_state
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `, OPERATION)).toEqual({
      status: 'failed', retryable: 1,
      failure_code: 'COVER_RENDER_UNAVAILABLE', dispatch_state: 'failed',
    });
    expect(await row('SELECT state FROM event_cover_render_sets WHERE id = ?', set.id))
      .toEqual({ state: 'staging' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'publishing' });
  });

  it('returns skipped when a newer dispatch generation supersedes finalize', async () => {
    await prepared();
    let winnerReceipt: unknown;
    let winnerFence: unknown;
    const raced = envBeforeFirstBatch(async () => {
      await testEnv.DB.batch([
        testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts
          SET dispatch_state = 'restarting', dispatch_generation = dispatch_generation + 1
          WHERE operation_id = ?
        `).bind(OPERATION),
        testEnv.DB.prepare(`
          UPDATE event_cover_workflow_fences
          SET dispatch_generation = dispatch_generation + 1
          WHERE event_id = ?
        `).bind(access.event.id),
      ]);
      winnerReceipt = await row('SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION);
      winnerFence = await row('SELECT * FROM event_cover_workflow_fences WHERE event_id = ?', access.event.id);
    });

    expect((await coverRenderFinalize(raced, {
      eventId: access.event.id, operationId: OPERATION,
    }, now)).status).toBe('skipped');
    expect(await row('SELECT * FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual(winnerReceipt);
    expect(await row('SELECT * FROM event_cover_workflow_fences WHERE event_id = ?', access.event.id))
      .toEqual(winnerFence);
  });

  it('refuses to activate an incomplete manifest', async () => {
    const { draft } = await prepared();
    await testEnv.DB.prepare(`
      DELETE FROM event_cover_render_objects WHERE profile_id = 'short-lookup'
    `).run();

    const outcome = await coverRenderFinalize(testEnv, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(outcome).toMatchObject({ status: 'failed', retryable: false });
    expect((await new EventsRepository(testEnv.DB).getById(access.event.id))!.coverRenderSetId).toBeNull();
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'ready' });
  });

  it('cannot be overwritten by a late failure handler', async () => {
    await prepared();
    await coverRenderFinalize(testEnv, { eventId: access.event.id, operationId: OPERATION }, now);
    // A step that finished after the finalize already applied.
    const late = await coverRenderPreflight(renderEnv(), {
      eventId: access.event.id, operationId: OPERATION,
    }, now);
    expect(late.shouldRender).toBe(false);
    expect(await row('SELECT status FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION))
      .toEqual({ status: 'applied' });
  });
});

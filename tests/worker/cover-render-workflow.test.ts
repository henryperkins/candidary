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
const OPERATION = '5f3a2b18-6c2d-4f0e-9a71-0c2d1e8b4a55';
const FENCE_HOLD = '9999-12-31T23:59:59.999Z';

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

it('holds a newly accepted render fence open beyond 32 days', async () => {
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
  await cleanupEventCovers(testEnv, new Date(created.getTime() + 32 * 24 * 60 * 60 * 1000));
  expect(await row('SELECT expires_at FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
    accepted.receipt.workflow_instance_id)).toEqual({ expires_at: FENCE_HOLD });
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

  it('records a conflict for a known-stale event without transforming anything', async () => {
    await publication(access, { width: 2480, height: 1680 });
    const { draft } = await row<{ draft: string }>(
      'SELECT draft_id AS draft FROM event_cover_publish_receipts WHERE operation_id = ?', OPERATION,
    );
    await testEnv.DB.prepare('UPDATE events SET cover_revision = 9 WHERE id = ?')
      .bind(access.event.id).run();

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
    await coverRenderPreflight(renderEnv(), { eventId: access.event.id, operationId: OPERATION }, now);
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
  const legacy = (id: string) => `events/${id}/cover/9f1c-porch.jpg`;

  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  async function prepared(withLegacyCover = false) {
    if (withLegacyCover) {
      await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
        .bind(legacy(access.event.id), access.event.id).run();
      await testEnv.MEDIA_BUCKET.put(legacy(access.event.id), new Uint8Array([1, 2, 3]));
    }
    const result = await publication(access, { width: 2480, height: 1680 });
    const env = renderEnv();
    await coverRenderPreflight(env, { eventId: access.event.id, operationId: OPERATION }, now);
    await runEveryProfile(env, access.event.id);
    return result;
  }

  it('commits the pointer, the retirement, both set transitions, and both terminal flips together', async () => {
    const { draft } = await prepared(true);
    const outcome = await coverRenderFinalize(testEnv, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

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
      .toEqual({ expires_at: '2026-09-04T12:00:00.000Z' });

    // The displaced legacy original is inventoried by the same statements that
    // moved the pointer, and is still in R2.
    expect(await row('SELECT object_key, reason FROM event_cover_retired_legacy_objects WHERE event_id = ?', access.event.id))
      .toEqual({ object_key: legacy(access.event.id), reason: 'replaced' });
    expect(await testEnv.MEDIA_BUCKET.head(legacy(access.event.id))).not.toBeNull();
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
    const { draft } = await prepared(true);
    await testEnv.DB.prepare('UPDATE events SET cover_revision = 7 WHERE id = ?')
      .bind(access.event.id).run();

    const outcome = await coverRenderFinalize(testEnv, {
      eventId: access.event.id, operationId: OPERATION,
    }, now);

    expect(outcome.status).toBe('conflict');
    const event = (await new EventsRepository(testEnv.DB).getById(access.event.id))!;
    expect(event.coverRevision).toBe(7);
    // The winning cover is untouched, and no retirement row was written.
    expect(event.coverObjectKey).toBe(legacy(access.event.id));
    expect(event.coverRenderSetId).toBeNull();
    expect(await row('SELECT count(*) AS count FROM event_cover_retired_legacy_objects WHERE event_id = ?', access.event.id))
      .toEqual({ count: 0 });
    expect(await row('SELECT state FROM event_cover_render_sets WHERE event_id = ?', access.event.id))
      .toEqual({ state: 'abandoned' });
    expect(await row('SELECT state FROM event_cover_drafts WHERE id = ?', draft.id))
      .toEqual({ state: 'ready' });
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

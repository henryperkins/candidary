import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_COVER_PUBLICATIONS_PER_HOUR } from '../../shared/constants';
import type { EventCoverPublishRequestV1 } from '../../shared/event-cover';
import { createCoverDraft, insertCoverMaster } from '../../worker/db/event-covers';
import { EventsRepository } from '../../worker/db/events';
import type { EventRecord } from '../../worker/db/types';
import {
  acceptCoverPublication,
  applyRemovalPublication,
  confirmCoverDispatch,
  coverWorkflowInstanceId,
  mapPlatformStatus,
  markDispatchFailed,
  readCoverPublication,
  restartCoverPublication,
  selectEventCoverPreparation,
  type CoverWorkflowAccessor,
} from '../../worker/services/event-cover-publication';
import { coverMasterKey } from '../../worker/storage/event-cover-keys';
import { eventAccess, resetDatabase, testEnv } from './helpers';

const now = new Date('2026-08-04T12:00:00.000Z');
const HEX_64 = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);
const OPERATION = '5f3a2b18-6c2d-4f0e-9a71-0c2d1e8b4a55';

type Access = Awaited<ReturnType<typeof eventAccess>>;

/** Records every lifecycle call, because none of them has a precedent locally. */
function fakeWorkflow(status = 'running', failures: Partial<Record<string, boolean>> = {}) {
  const calls: string[] = [];
  const accessor: CoverWorkflowAccessor = {
    async create(id) { calls.push(`create:${id}`); if (failures.create) throw new Error('dispatch'); },
    async status() { calls.push('status'); return status; },
    async resume(id) { calls.push(`resume:${id}`); if (failures.resume) throw new Error('resume'); },
    async restart(id) { calls.push(`restart:${id}`); if (failures.restart) throw new Error('restart'); },
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

async function draftState(id: string): Promise<string> {
  const row = await testEnv.DB.prepare('SELECT state FROM event_cover_drafts WHERE id = ?')
    .bind(id).first<{ state: string }>();
  return row!.state;
}

describe('platform status map', () => {
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
    expect(mapPlatformStatus('not-found')).toMatchObject({ kind: 'missing', recovery: 'create' });

    // The preserving default: an unrecognized value keeps product state and
    // reports itself rather than being guessed at.
    const unmapped = mapPlatformStatus('someFutureState');
    expect(unmapped).toMatchObject({ kind: 'active', mutates: false, productStatus: 'preparing' });
    expect(unmapped.telemetry).toContain('someFutureState');
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
    await testEnv.DB.prepare('UPDATE events SET cover_revision = 3 WHERE id = ?')
      .bind(access.event.id).run();
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
    const workflow = fakeWorkflow();
    const confirmed = await confirmCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
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
    // Deletion blocked the fence between the D1 commit and the platform call.
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences SET state = 'deletion-blocked' WHERE workflow_instance_id = ?
    `).bind(publication.receipt.workflow_instance_id).run();

    const workflow = fakeWorkflow();
    const confirmed = await confirmCoverDispatch(testEnv, {
      eventId: access.event.id,
      operationId: OPERATION,
      workflowInstanceId: publication.receipt.workflow_instance_id!,
      now,
      workflow: workflow.accessor,
    });

    expect(confirmed).toBe(false);
    // The mandatory post-call check, and no successful dispatch recorded.
    expect(workflow.calls).toContain(`terminate:${publication.receipt.workflow_instance_id}`);
    const receipt = await testEnv.DB.prepare(
      'SELECT status, dispatch_state, retryable FROM event_cover_publish_receipts WHERE operation_id = ?',
    ).bind(OPERATION).first();
    expect(receipt).toEqual({ status: 'failed', dispatch_state: 'failed', retryable: 1 });
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
    for (const platform of ['paused', 'errored', 'terminated', 'complete', 'not-found']) {
      const view = await readCoverPublication(testEnv, {
        eventId: access.event.id, operationId: OPERATION, now,
        workflow: fakeWorkflow(platform).accessor,
      });
      expect(view, platform).toMatchObject({ status: 'retryable-failed', retryable: true });
      // Read-only: the Workflow handler, the restart POST, and bounded cleanup
      // are the authoritative writers.
      expect(await storedStatus(), platform).toEqual({ status: 'queued', retryable: 0 });
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

  it('recreates a confirmed-missing instance under the same fenced ID', async () => {
    const workflow = fakeWorkflow('not-found');
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

  it('refuses a permanent failure, a terminal receipt, and a lapsed restart window', async () => {
    await testEnv.DB.prepare('UPDATE event_cover_publish_receipts SET retryable = 0 WHERE operation_id = ?')
      .bind(OPERATION).run();
    expect((await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: fakeWorkflow('errored').accessor,
    })).status).toBe('ineligible');

    await testEnv.DB.prepare(`UPDATE event_cover_publish_receipts SET status = 'applied' WHERE operation_id = ?`)
      .bind(OPERATION).run();
    expect((await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: fakeWorkflow('errored').accessor,
    })).status).toBe('terminal');

    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts SET status = 'failed', retryable = 1 WHERE operation_id = ?
    `).bind(OPERATION).run();
    const late = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    expect((await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now: late,
      workflow: fakeWorkflow('errored').accessor,
    })).status).toBe('ineligible');
  });

  it('terminates and records nothing when deletion blocked the fence', async () => {
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences SET state = 'deletion-blocked' WHERE workflow_instance_id = ?
    `).bind(instanceId).run();
    const workflow = fakeWorkflow('errored');
    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: workflow.accessor,
    });
    expect(result.status).toBe('ineligible');
    expect(workflow.calls).toContain(`terminate:${instanceId}`);
  });

  it('refuses to revive stale work after a newer publication moved the revision', async () => {
    await testEnv.DB.prepare('UPDATE events SET cover_revision = 5 WHERE id = ?')
      .bind(access.event.id).run();
    const result = await restartCoverPublication(testEnv, {
      eventId: access.event.id, operationId: OPERATION, now, workflow: fakeWorkflow('errored').accessor,
    });
    expect(result.status).toBe('ineligible');
  });
});

describe('synchronous removal publication', () => {
  let access: Access;
  const legacyKey = (id: string) => `events/${id}/cover/9f1c-porch.jpg`;

  beforeEach(async () => {
    await resetDatabase();
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

  it('writes no retirement row when it loses its revision guard', async () => {
    await acceptRemoval();
    await testEnv.DB.prepare('UPDATE events SET cover_revision = 4 WHERE id = ?')
      .bind(access.event.id).run();

    await expect(applyRemovalPublication(testEnv, {
      event: { ...await reload(access.event.id), coverRevision: 0 },
      operationId: OPERATION, requestDigest: HEX_64, expectedRevision: 0, now,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 409 });

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
});

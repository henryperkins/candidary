import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { EventsRepository } from '../../worker/db/events';
import { selectGuestEventView, selectManagerEventView } from '../../worker/http/event-view';
import { coverMasterKey, coverRenderKey } from '../../worker/storage/event-cover-keys';
import { eventAccess, resetDatabase, seedEventCoverGraph, testEnv } from './helpers';

const now = new Date('2026-08-04T12:00:00.000Z');
const HEX_64 = 'a'.repeat(64);

type Access = Awaited<ReturnType<typeof eventAccess>>;

async function reload(eventId: string) {
  return (await new EventsRepository(testEnv.DB).getById(eventId))!;
}

/** A valid active render set with its `wide-expanded` 1x JPEG present in R2. */
async function activeRenderSet(access: Access) {
  const eventId = access.event.id;
  const timestamp = now.toISOString();
  const graph = await seedEventCoverGraph(testEnv.DB, eventId, timestamp);
  const derivative = coverRenderKey(eventId, graph.renderSetId, 'wide-expanded', '1x', 'jpeg');
  await testEnv.MEDIA_BUCKET.put(derivative, new Uint8Array(40).fill(9), {
    httpMetadata: { contentType: 'image/jpeg' },
  });

  await testEnv.DB.prepare(
    `UPDATE events
     SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
     WHERE id = ?`,
  ).bind(
    '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
    coverMasterKey(eventId, graph.masterId),
    graph.renderSetId,
    eventId,
  ).run();
  return derivative;
}

async function legacyOriginal(access: Access) {
  const key = `events/${access.event.id}/cover/9f1c-porch.png`;
  // The post-0014 schema makes this row unrepresentable. Drop only the pointer
  // guard to retain one compatibility-reader regression for an old snapshot.
  await testEnv.DB.prepare('DROP TRIGGER event_cover_source_pointer_update').run();
  await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
    .bind(key, access.event.id).run();
  await testEnv.MEDIA_BUCKET.put(key, new Uint8Array(24).fill(1), {
    httpMetadata: { contentType: 'image/png' },
  });
  return key;
}

describe('nested cover projection', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('projects capability, never the repurposed master key, to either audience', async () => {
    await activeRenderSet(access);
    const event = await reload(access.event.id);

    for (const view of [
      await selectManagerEventView(testEnv, event, now),
      await selectGuestEventView(testEnv.DB, event, now),
    ]) {
      expect(view.cover.hasCover).toBe(true);
      expect(JSON.stringify(view.cover)).not.toContain('events/');
      expect(view).not.toHaveProperty('coverObjectKey');
    }
  });

  it('projects an explicit no-cover capability instead of a null sentinel', async () => {
    const bare = await reload(access.event.id);
    expect((await selectManagerEventView(testEnv, bare, now)).cover.hasCover).toBe(false);
    expect((await selectGuestEventView(testEnv.DB, bare, now)).cover.hasCover).toBe(false);
  });

  it('projects the revision a first publication has no other way to learn', async () => {
    expect((await selectManagerEventView(testEnv, await reload(access.event.id), now)).cover.revision)
      .toBe(0);
    await activeRenderSet(access);
    expect((await selectManagerEventView(testEnv, await reload(access.event.id), now)).cover.revision)
      .toBe(1);
  });
});

describe('manager event read', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  async function managerEvent() {
    const response = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(response.status).toBe(200);
    return (await response.json<any>()).data.event;
  }

  async function seedReceipt(status: string, retryable = 0) {
    const timestamp = now.toISOString();
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (event_id, operation_id, request_sha256, action,
        expected_revision, status, dependency_versions_json, completed_profiles, required_profiles,
        retryable, dispatch_state, created_at, updated_at, expires_at)
      VALUES (?, 'op-1', ?, 'publish', 0, ?, '{}', 2, 6, ?, 'confirmed', ?, ?, ?)
    `).bind(access.event.id, HEX_64, status, retryable, timestamp, new Date().toISOString(), timestamp)
      .run();
  }

  it('carries the server-selected preparation while a receipt is nonterminal', async () => {
    await seedReceipt('rendering');
    // No session storage involved: the server picks the receipt, which is what
    // makes a reload with cleared local state still resume.
    expect(await managerEvent()).toMatchObject({
      cover: {
        preparation: {
          operationId: 'op-1', status: 'preparing', completedSteps: 2, requiredSteps: 6,
        },
      },
    });
  });

  it('carries null when nothing is selectable', async () => {
    expect((await managerEvent()).cover.preparation).toBeNull();
  });

  it('never leaks a workflow ID, object key, or platform status', async () => {
    await seedReceipt('failed', 1);
    const preparation = (await managerEvent()).cover.preparation;
    expect(Object.keys(preparation).sort()).toEqual([
      'completedSteps', 'operationId', 'requiredSteps', 'retryable',
      'safeFailureCode', 'status', 'updatedAt',
    ]);
    expect(preparation.status).toBe('retryable-failed');
  });

  it('gives a guest neither field', async () => {
    await seedReceipt('rendering');
    const response = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    const event = (await response.json<any>()).data.event;
    expect(event).not.toHaveProperty('coverPreparation');
    expect(event).not.toHaveProperty('coverRevision');
    expect(Object.keys(event.cover).sort()).toEqual([
      'available2xProfiles', 'hasCover', 'revision', 'surfaceTreatment',
    ]);
    expect(event.cover).not.toHaveProperty('config');
    expect(event.cover).not.toHaveProperty('preparation');
  });
});

describe('compatibility cover delivery', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  const guestCover = () => createApp().request(
    `/api/event/${access.event.slug}/cover`, { headers: { cookie: access.guest.cookie } }, testEnv,
  );
  const managerCover = () => createApp().request(
    `/api/manage/events/${access.event.id}/cover`, { headers: { cookie: access.manager.cookie } }, testEnv,
  );

  it('serves the active set’s wide-expanded 1x JPEG, never the normalized master', async () => {
    const derivative = await activeRenderSet(access);
    for (const response of [await guestCover(), await managerCover()]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      // 40 bytes is the derivative; the master row records 900,000.
      expect(response.headers.get('content-length')).toBe('40');
    }
    expect(derivative).toContain('/rendered/');
  });

  it('keeps the current original response for a legacy null-set row', async () => {
    await legacyOriginal(access);
    const response = await guestCover();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe('24');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('is the existing 404 when there is no cover at all', async () => {
    const response = await guestCover();
    expect(response.status).toBe(404);
    expect((await response.json<any>()).code).toBe('EVENT_NOT_FOUND');
  });

  it('never falls back when a derivative is missing', async () => {
    const derivative = await activeRenderSet(access);
    await testEnv.MEDIA_BUCKET.delete(derivative);
    // The master is still in the bucket and still named by cover_object_key.
    await testEnv.MEDIA_BUCKET.put(coverMasterKey(access.event.id, 'm1'), new Uint8Array(9));

    const response = await guestCover();
    expect(response.status).toBe(404);
    expect((await response.json<any>()).code).toBe('UPLOAD_OBJECT_MISSING');
  });

  it('refuses a manager cover request carrying only a guest cookie', async () => {
    await activeRenderSet(access);
    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/cover`,
      { headers: { cookie: access.guest.cookie } },
      testEnv,
    );
    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('ROLE_FORBIDDEN');
  });

  it('preserves the guest route’s deliberately loose slug check', async () => {
    await activeRenderSet(access);
    const other = await eventAccess('Other Event');
    // Session slug versus path slug, and nothing else: no role, gallery, phase,
    // or uploads test. That looseness is intentional and is preserved exactly.
    const crossEvent = await createApp().request(
      `/api/event/${other.event.slug}/cover`, { headers: { cookie: access.guest.cookie } }, testEnv,
    );
    expect(crossEvent.status).toBe(404);

    await testEnv.DB.prepare('UPDATE events SET gallery_visible = 0, uploads_enabled = 0 WHERE id = ?')
      .bind(access.event.id).run();
    expect((await guestCover()).status).toBe(200);
  });
});

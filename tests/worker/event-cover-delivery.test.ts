import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { EventsRepository } from '../../worker/db/events';
import { eventView, guestEventView } from '../../worker/http/event-view';
import { coverMasterKey, coverRenderKey } from '../../worker/storage/event-cover-keys';
import { eventAccess, resetDatabase, testEnv } from './helpers';

const now = new Date('2026-08-04T12:00:00.000Z');
const HEX_64 = 'a'.repeat(64);

type Access = Awaited<ReturnType<typeof eventAccess>>;

async function reload(eventId: string) {
  return (await new EventsRepository(testEnv.DB).getById(eventId))!;
}

/** An active render set with its `wide-expanded` 1x JPEG present in R2. */
async function activeRenderSet(access: Access) {
  const eventId = access.event.id;
  const timestamp = now.toISOString();
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_masters (id, event_id, object_key, mime_type, byte_size, width,
      height, sha256, normalization_version, normalization_rung, created_at)
    VALUES ('m1', ?, ?, 'image/webp', 900000, 2480, 1680, ?, 1, 1, ?)
  `).bind(eventId, coverMasterKey(eventId, 'm1'), HEX_64, timestamp).run();
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_render_sets (id, event_id, master_id, recipe_json, recipe_sha256,
      state, required_slots, manifest_sha256, published_revision, created_at)
    VALUES ('s1', ?, 'm1', '{}', ?, 'active', 12, ?, 1, ?)
  `).bind(eventId, HEX_64, HEX_64, timestamp).run();

  const derivative = coverRenderKey(eventId, 's1', 'wide-expanded', '1x', 'jpeg');
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_render_objects (id, render_set_id, event_id, profile_id, density,
      format, object_key, content_type, byte_size, width, height, quality_rung, sha256, created_at)
    VALUES ('o1', 's1', ?, 'wide-expanded', '1x', 'jpeg', ?, 'image/jpeg', 40, 620, 420, 1, ?, ?)
  `).bind(eventId, derivative, HEX_64, timestamp).run();
  await testEnv.MEDIA_BUCKET.put(derivative, new Uint8Array(40).fill(9), {
    httpMetadata: { contentType: 'image/jpeg' },
  });

  await testEnv.DB.prepare(
    'UPDATE events SET cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1 WHERE id = ?',
  ).bind(coverMasterKey(eventId, 'm1'), 's1', eventId).run();
  return derivative;
}

async function legacyOriginal(access: Access) {
  const key = `events/${access.event.id}/cover/9f1c-porch.png`;
  await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
    .bind(key, access.event.id).run();
  await testEnv.MEDIA_BUCKET.put(key, new Uint8Array(24).fill(1), {
    httpMetadata: { contentType: 'image/png' },
  });
  return key;
}

describe('cover presence projection', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('projects a constant sentinel, never the repurposed key, to either audience', async () => {
    await activeRenderSet(access);
    const event = await reload(access.event.id);

    for (const view of [eventView(event, now), guestEventView(event, now)]) {
      expect(view.coverObjectKey).toBe('cover-present');
      // The column now holds a private normalized master. Projecting it would
      // be worse than the status quo, not merely unchanged.
      expect(view.coverObjectKey).not.toContain('events/');
      expect(view.coverObjectKey!.startsWith('events/')).toBe(false);
    }
  });

  it('projects the same sentinel for a legacy original, and null for no cover', async () => {
    await legacyOriginal(access);
    expect(eventView(await reload(access.event.id), now).coverObjectKey).toBe('cover-present');

    await testEnv.DB.prepare('UPDATE events SET cover_object_key = NULL WHERE id = ?')
      .bind(access.event.id).run();
    const bare = await reload(access.event.id);
    expect(eventView(bare, now).coverObjectKey).toBeNull();
    expect(guestEventView(bare, now).coverObjectKey).toBeNull();
  });

  it('projects the revision a first publication has no other way to learn', async () => {
    expect(eventView(await reload(access.event.id), now).coverRevision).toBe(0);
    await activeRenderSet(access);
    expect(eventView(await reload(access.event.id), now).coverRevision).toBe(1);
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
      coverPreparation: {
        operationId: 'op-1', status: 'preparing', completedSteps: 2, requiredSteps: 6,
      },
    });
  });

  it('carries null when nothing is selectable', async () => {
    expect((await managerEvent()).coverPreparation).toBeNull();
  });

  it('never leaks a workflow ID, object key, or platform status', async () => {
    await seedReceipt('failed', 1);
    const preparation = (await managerEvent()).coverPreparation;
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

import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { MediaRepository } from '../../worker/db/media';
import type { AppEnv } from '../../worker/env';
import { cleanupExpiredReservations, resumeDeletedEventPurges } from '../../worker/workflows/cleanup';
import releaseConfig from '../../config/media-upload-release.json';
import {
  eventAccess,
  png,
  resetDatabase,
  testEnv,
  writeHeaders,
} from './helpers';

type TestAppEnv = AppEnv & { TEST_MEDIA_UPLOAD_RELEASE_MODE?: string };

function bridgeEnv(): { env: AppEnv; operations: string[] } {
  const operations: string[] = [];
  const bucket = new Proxy(testEnv.MEDIA_BUCKET, {
    get(target, property) {
      if (typeof property === 'string' && ['put', 'get', 'head', 'delete', 'list'].includes(property)) {
        return (...args: unknown[]) => {
          operations.push(property);
          const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
          return Reflect.apply(method, target, args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const base = { ...testEnv, MEDIA_BUCKET: bucket } as TestAppEnv;
  delete base.TEST_MEDIA_UPLOAD_RELEASE_MODE;
  return {
    env: new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'R2_ACCESS_KEY_ID' || property === 'R2_SECRET_ACCESS_KEY') {
          throw new Error(`Bridge accessed retired signer secret ${String(property)}.`);
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }),
    operations,
  };
}

function oldFinalizeBeforeDeleteEnv(mediaId: string, eventId: string, byteSize: number): AppEnv {
  let raced = false;
  const db = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await target.batch([
              target.prepare(`
                UPDATE media SET upload_state = 'stored', byte_size = ?, width = 1, height = 1
                WHERE id = ? AND upload_state = 'reserved'
              `).bind(byteSize, mediaId),
              target.prepare(`
                UPDATE events SET
                  reserved_media_count = reserved_media_count - 1,
                  reserved_bytes = reserved_bytes - ?,
                  stored_media_count = stored_media_count + 1,
                  stored_bytes = stored_bytes + ?
                WHERE id = ?
              `).bind(byteSize, byteSize, eventId),
            ]);
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

async function initiate(
  access: Awaited<ReturnType<typeof eventAccess>>,
  idempotencyKey: string,
  env: AppEnv = testEnv,
) {
  return createApp().request(`/api/event/${access.event.slug}/uploads`, {
    method: 'POST',
    headers: writeHeaders(access.guest),
    body: JSON.stringify({
      filename: `${idempotencyKey}.png`,
      mimeType: 'image/png',
      byteSize: 64,
      idempotencyKey,
      guestName: 'Avery',
    }),
  }, env);
}

describe('schema-14 media write bridge', () => {
  beforeEach(resetDatabase);

  it('consumes the exact eight-capability disabled contract', () => {
    expect(releaseConfig).toEqual({
      kind: 'candidary.media-upload-release',
      schemaVersion: 1,
      mode: 'bridge-disabled',
      capabilities: {
        singleInitiationPresign: false,
        batchInitiationPresign: false,
        storedReplayPresign: false,
        reservedFinalize: false,
        exportDownloadPresign: false,
        authenticatedWorkerIngress: false,
        legacyPromotion: false,
        eventRelationalPurge: false,
      },
    });
  });

  it('rejects single, stored-replay, and batch initiation before a reservation or signer read', async () => {
    const access = await eventAccess();
    const storedInitiation = await initiate(access, 'stored-replay');
    const stored = (await storedInitiation.json<any>()).data.media;
    await testEnv.MEDIA_BUCKET.put(stored.objectKey, png(), {
      httpMetadata: { contentType: 'image/png' },
    });
    const finalized = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${stored.id}/finalize`,
      { method: 'POST', headers: writeHeaders(access.guest), body: '{}' },
      testEnv,
    );
    expect(finalized.status).toBe(200);

    const before = await testEnv.DB.prepare(
      'SELECT count(*) AS count FROM media WHERE event_id = ?',
    ).bind(access.event.id).first<{ count: number }>();
    const bridge = bridgeEnv();
    const single = await initiate(access, 'new-single', bridge.env);
    const replay = await initiate(access, 'stored-replay', bridge.env);
    const batch = await createApp().request(`/api/event/${access.event.slug}/uploads/batch`, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({
        guestName: 'Avery',
        files: [{
          filename: 'new-batch.png', mimeType: 'image/png', byteSize: 64,
          idempotencyKey: 'new-batch',
        }],
      }),
    }, bridge.env);

    for (const response of [single, replay, batch]) {
      expect(response.status).toBe(409);
      expect(await response.json<any>()).toMatchObject({ code: 'UPLOADS_DISABLED' });
    }
    expect(await testEnv.DB.prepare(
      'SELECT count(*) AS count FROM media WHERE event_id = ?',
    ).bind(access.event.id).first()).toEqual(before);
    expect(bridge.operations).toEqual([]);
  });

  it('keeps stored finalize idempotent but rejects reserved finalize without touching R2', async () => {
    const access = await eventAccess();
    const storedInitiation = await initiate(access, 'already-stored');
    const stored = (await storedInitiation.json<any>()).data.media;
    await testEnv.MEDIA_BUCKET.put(stored.objectKey, png(), {
      httpMetadata: { contentType: 'image/png' },
    });
    expect((await createApp().request(
      `/api/event/${access.event.slug}/uploads/${stored.id}/finalize`,
      { method: 'POST', headers: writeHeaders(access.guest), body: '{}' },
      testEnv,
    )).status).toBe(200);

    const reserved = (await (await initiate(access, 'still-reserved')).json<any>()).data.media;
    await testEnv.MEDIA_BUCKET.put(reserved.objectKey, png(), {
      httpMetadata: { contentType: 'image/png' },
    });
    const bridge = bridgeEnv();
    const storedReplay = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${stored.id}/finalize`,
      { method: 'POST', headers: writeHeaders(access.guest), body: '{}' },
      bridge.env,
    );
    const reservedFinalize = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${reserved.id}/finalize`,
      { method: 'POST', headers: writeHeaders(access.guest), body: '{}' },
      bridge.env,
    );

    expect(storedReplay.status).toBe(200);
    expect((await storedReplay.json<any>()).data.media).toMatchObject({
      id: stored.id,
      uploadState: 'stored',
    });
    expect(reservedFinalize.status).toBe(409);
    expect(await reservedFinalize.json<any>()).toMatchObject({ code: 'UPLOADS_DISABLED' });
    expect(await testEnv.DB.prepare(
      'SELECT upload_state FROM media WHERE id = ?',
    ).bind(reserved.id).first()).toEqual({ upload_state: 'reserved' });
    expect(bridge.operations).toEqual([]);
  });

  it('soft-deletes and revokes an event while preserving relational rows and R2 for 0015 seeding', async () => {
    const access = await eventAccess();
    const initiated = await initiate(access, 'purge-held');
    const media = (await initiated.json<any>()).data.media;
    await testEnv.MEDIA_BUCKET.put(media.objectKey, png());
    const bridge = bridgeEnv();

    const response = await createApp().request(`/api/manage/events/${access.event.id}`, {
      method: 'DELETE',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({ confirmation: access.event.name }),
    }, bridge.env);

    expect(response.status).toBe(202);
    expect(await response.json<any>()).toMatchObject({ data: { deletionScheduled: true } });
    expect(await testEnv.DB.prepare(
      'SELECT deleted_at FROM events WHERE id = ?',
    ).bind(access.event.id).first<{ deleted_at: string | null }>()).toEqual({
      deleted_at: expect.any(String),
    });
    expect(await testEnv.DB.prepare(
      'SELECT id FROM media WHERE id = ?',
    ).bind(media.id).first()).toEqual({ id: media.id });
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();
    expect(bridge.operations).toEqual([]);

    expect(await resumeDeletedEventPurges(
      bridge.env,
      new Date('2030-01-01T00:00:00.000Z'),
    )).toBe(0);
    expect(await testEnv.DB.prepare(
      'SELECT id FROM events WHERE id = ?',
    ).bind(access.event.id).first()).toEqual({ id: access.event.id });
    expect(await testEnv.DB.prepare(
      'SELECT id FROM media WHERE id = ?',
    ).bind(media.id).first()).toEqual({ id: media.id });
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();
    expect(bridge.operations).toEqual([]);
  });

  it('preserves expired reservations and their objects for the guarded migration', async () => {
    const access = await eventAccess();
    const reserved = (await (await initiate(access, 'expired-held')).json<any>()).data.media;
    await testEnv.DB.prepare('UPDATE media SET reservation_expires_at = ? WHERE id = ?')
      .bind('2026-08-13T00:00:00.000Z', reserved.id).run();
    await testEnv.MEDIA_BUCKET.put(reserved.objectKey, png());
    const bridge = bridgeEnv();

    expect(await cleanupExpiredReservations(
      bridge.env,
      new Date('2026-08-13T01:00:00.000Z'),
    )).toBe(0);
    expect(await new MediaRepository(testEnv.DB).getById(reserved.id)).toMatchObject({
      uploadState: 'reserved',
    });
    expect(await testEnv.MEDIA_BUCKET.head(reserved.objectKey)).not.toBeNull();
    expect(bridge.operations).toEqual([]);
  });

  it.each(['guest', 'manager'] as const)(
    'commits a %s delete when an admitted old finalizer wins the first state race',
    async (actor) => {
      const access = await eventAccess();
      const reserved = (await (await initiate(access, `delete-race-${actor}`)).json<any>()).data.media;
      await testEnv.MEDIA_BUCKET.put(reserved.objectKey, png());
      const env = oldFinalizeBeforeDeleteEnv(reserved.id, access.event.id, reserved.declaredByteSize);

      const response = actor === 'guest'
        ? await createApp().request(`/api/event/${access.event.slug}/uploads/${reserved.id}`, {
          method: 'DELETE', headers: writeHeaders(access.guest), body: '{}',
        }, env)
        : await createApp().request(`/api/manage/events/${access.event.id}/media/${reserved.id}`, {
          method: 'PATCH', headers: writeHeaders(access.manager),
          body: JSON.stringify({ action: 'delete', expectedStatus: 'unpublished' }),
        }, env);

      expect(response.status).toBe(200);
      expect((await response.json<any>()).data.media).toMatchObject({ uploadState: 'deleted' });
      expect(await new MediaRepository(testEnv.DB).getById(reserved.id)).toMatchObject({
        uploadState: 'deleted', deletedAt: expect.any(String),
      });
      expect(await testEnv.DB.prepare(`
        SELECT reserved_media_count, reserved_bytes, stored_media_count, stored_bytes
        FROM events WHERE id = ?
      `).bind(access.event.id).first()).toEqual({
        reserved_media_count: 0,
        reserved_bytes: 0,
        stored_media_count: 0,
        stored_bytes: 0,
      });
      expect(await testEnv.MEDIA_BUCKET.head(reserved.objectKey)).toBeNull();
    },
  );
});

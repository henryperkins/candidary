import { beforeEach, describe, expect, it } from 'vitest';

import {
  EVENT_COVER_PROFILES,
  type EventCoverDensity,
  type EventCoverFormat,
  type EventCoverPublishRequestV1,
} from '../../shared/event-cover';
import { createApp } from '../../worker/app';
import { EventsRepository } from '../../worker/db/events';
import type { AppEnv } from '../../worker/env';
import { selectGuestEventView, selectManagerEventView } from '../../worker/http/event-view';
import { acceptCoverPublication } from '../../worker/services/event-cover-publication';
import { coverMasterKey, coverRenderKey } from '../../worker/storage/event-cover-keys';
import {
  eventAccess,
  resetDatabase,
  seedEventCoverGraph,
  testEnv,
  withRecordingImages,
  writeHeaders,
} from './helpers';

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

const DENSITIES = ['1x', '2x'] as const satisfies readonly EventCoverDensity[];
const FORMATS = ['webp', 'jpeg'] as const satisfies readonly EventCoverFormat[];

async function fullActiveRenderSet(access: Access) {
  const eventId = access.event.id;
  const timestamp = now.toISOString();
  const graph = await seedEventCoverGraph(testEnv.DB, eventId, timestamp);

  // The shared graph intentionally contains only the required 1x manifest.
  // This fixture extends it to the optional, paired 2x matrix before delivery.
  // Production can only add these rows while staging; dropping the frozen-row
  // fixture guard here avoids broadening the shared helper used by other suites.
  await testEnv.DB.exec('DROP TRIGGER event_cover_render_object_manifest_insert');
  await testEnv.DB.batch(EVENT_COVER_PROFILES.flatMap((profile) => FORMATS.map((format) => (
    testEnv.DB.prepare(`
      INSERT INTO event_cover_render_objects (
        id, render_set_id, event_id, profile_id, density, format, object_key,
        content_type, byte_size, width, height, quality_rung, sha256, created_at
      ) VALUES (?, ?, ?, ?, '2x', ?, ?, ?, 120000, ?, ?, 1, ?, ?)
    `).bind(
      `object-2x-${profile.id}-${format}`,
      graph.renderSetId,
      eventId,
      profile.id,
      format,
      coverRenderKey(eventId, graph.renderSetId, profile.id, '2x', format),
      format === 'webp' ? 'image/webp' : 'image/jpeg',
      profile.width * 2,
      profile.height * 2,
      HEX_64,
      timestamp,
    )
  ))));
  await testEnv.DB.prepare(
    'UPDATE event_cover_render_sets SET required_slots = 24 WHERE id = ?',
  ).bind(graph.renderSetId).run();

  for (const profile of EVENT_COVER_PROFILES) {
    for (const density of DENSITIES) {
      for (const format of FORMATS) {
        const key = coverRenderKey(eventId, graph.renderSetId, profile.id, density, format);
        await testEnv.MEDIA_BUCKET.put(key, new Uint8Array([profile.width % 251, density === '2x' ? 2 : 1]), {
          httpMetadata: { contentType: format === 'webp' ? 'image/webp' : 'image/jpeg' },
        });
      }
    }
  }

  await testEnv.DB.prepare(`
    UPDATE events
    SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
    WHERE id = ?
  `).bind(
    '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
    coverMasterKey(eventId, graph.masterId),
    graph.renderSetId,
    eventId,
  ).run();
  return graph;
}

async function publishPreset(access: Access) {
  const request: EventCoverPublishRequestV1 = {
    operationId: '7b9fdcd0-9025-44c7-b061-a34073a16c89',
    expectedRevision: 0,
    source: { kind: 'preset', presetId: 'warm-linen' },
    effect: 'film',
  };
  await acceptCoverPublication(testEnv, {
    event: await reload(access.event.id), request, requestDigest: HEX_64, now,
  });
}

function observationEnv(): {
  env: AppEnv;
  sqlWrites: string[];
  r2Writes: string[];
  imageCalls: unknown[];
} {
  const sqlWrites: string[] = [];
  const r2Writes: string[] = [];
  const db = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/iu.test(sql)) {
            sqlWrites.push(sql);
          }
          return target.prepare(sql);
        };
      }
      if (property === 'batch' || property === 'exec') {
        return (...args: unknown[]) => {
          sqlWrites.push(String(args[0] ?? property));
          return Reflect.apply(target[property] as (...values: unknown[]) => unknown, target, args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const bucket = new Proxy(testEnv.MEDIA_BUCKET, {
    get(target, property) {
      if (property === 'put' || property === 'delete') {
        return (...args: unknown[]) => {
          r2Writes.push(`${String(property)}:${String(args[0])}`);
          return Reflect.apply(target[property] as (...values: unknown[]) => unknown, target, args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const images = withRecordingImages();
  return {
    env: { ...images.env, DB: db, MEDIA_BUCKET: bucket },
    sqlWrites,
    r2Writes,
    imageCalls: images.calls,
  };
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

describe('revisioned cover slot delivery', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  const guestSlot = (
    revision: string,
    profile: string = 'wide-expanded',
    density: string = '1x',
    format: string = 'jpeg',
    slug = access.event.slug,
    env: AppEnv = testEnv,
  ) => createApp().request(
    `/api/event/${slug}/cover/${revision}/${profile}/${density}.${format}`,
    { headers: { cookie: access.guest.cookie }, redirect: 'manual' },
    env,
  );

  const managerSlot = (
    revision: string,
    profile: string = 'wide-expanded',
    density: string = '1x',
    format: string = 'jpeg',
    eventId = access.event.id,
    env: AppEnv = testEnv,
  ) => createApp().request(
    `/api/manage/events/${eventId}/cover/${revision}/${profile}/${density}.${format}`,
    { headers: { cookie: access.manager.cookie }, redirect: 'manual' },
    env,
  );

  it('serves every registered upload slot to its authorized guest and manager without writes or Images', async () => {
    await fullActiveRenderSet(access);
    const observation = observationEnv();

    for (const profile of EVENT_COVER_PROFILES) {
      for (const density of DENSITIES) {
        for (const format of FORMATS) {
          for (const response of [
            await guestSlot('1', profile.id, density, format, access.event.slug, observation.env),
            await managerSlot('1', profile.id, density, format, access.event.id, observation.env),
          ]) {
            expect(response.status, `${profile.id}/${density}.${format}`).toBe(200);
            expect(response.headers.get('content-type')).toBe(format === 'webp' ? 'image/webp' : 'image/jpeg');
            expect(response.headers.get('cache-control')).toBe('private, no-store');
            expect(response.headers.get('x-content-type-options')).toBe('nosniff');
            expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(2);
          }
        }
      }
    }

    expect(observation.sqlWrites).toEqual([]);
    expect(observation.r2Writes).toEqual([]);
    expect(observation.imageCalls).toEqual([]);
  });

  it('does not register the revisionless compatibility reader', async () => {
    await fullActiveRenderSet(access);
    const compatibility = await createApp().request(
      `/api/event/${access.event.slug}/cover`,
      { headers: { cookie: access.guest.cookie } },
      testEnv,
    );
    const managerCompatibility = await createApp().request(
      `/api/manage/events/${access.event.id}/cover`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    const revisioned = await guestSlot('1');
    expect(compatibility.status).toBe(404);
    expect(managerCompatibility.status).toBe(404);
    expect(revisioned.status).toBe(200);
    expect(revisioned.headers.get('cache-control')).toBe('private, no-store');
  });

  it('redirects a current preset slot to its immutable event-free asset path', async () => {
    await publishPreset(access);

    for (const response of [
      await guestSlot('1', 'short-lookup', '2x', 'webp'),
      await managerSlot('1', 'short-lookup', '2x', 'webp'),
    ]) {
      expect(response.status).toBe(307);
      expect(response.headers.get('location'))
        .toBe('/assets/event-covers/v1/warm-linen/film/short-lookup-2x.webp');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('location')).not.toContain(access.event.id);
      expect(response.headers.get('location')).not.toContain(access.event.slug);
    }
  });

  it.each([
    ['leading-zero revision', ['01', 'wide-expanded', '1x', 'jpeg']],
    ['decimal revision', ['1.0', 'wide-expanded', '1x', 'jpeg']],
    ['negative revision', ['-1', 'wide-expanded', '1x', 'jpeg']],
    ['unsafe revision', ['9007199254740992', 'wide-expanded', '1x', 'jpeg']],
    ['unknown profile', ['1', 'unknown-profile', '1x', 'jpeg']],
    ['unknown density', ['1', 'wide-expanded', '3x', 'jpeg']],
    ['unknown format', ['1', 'wide-expanded', '1x', 'png']],
  ])('rejects an unsupported %s', async (_label, [revision, profile, density, format]) => {
    await fullActiveRenderSet(access);
    expect((await guestSlot(revision!, profile!, density!, format!)).status).toBe(404);
  });

  it('requires the exact current revision and never falls back to another slot or compatibility object', async () => {
    const graph = await fullActiveRenderSet(access);
    expect((await guestSlot('0')).status).toBe(404);
    expect((await guestSlot('2')).status).toBe(404);

    const missingKey = coverRenderKey(access.event.id, graph.renderSetId, 'wide-expanded', '2x', 'jpeg');
    await testEnv.MEDIA_BUCKET.delete(missingKey);
    await testEnv.MEDIA_BUCKET.put(`events/${access.event.id}/cover/legacy.jpg`, new Uint8Array([9]));
    const missing = await guestSlot('1', 'wide-expanded', '2x', 'jpeg');
    expect(missing.status).toBe(404);
    expect((await missing.json<any>()).code).toBe('UPLOAD_OBJECT_MISSING');
  });

  it('rejects wrong audiences, wrong event identity, retired and cross-event sets', async () => {
    const graph = await fullActiveRenderSet(access);
    const other = await eventAccess('Other Event');

    expect((await guestSlot('1', 'wide-expanded', '1x', 'jpeg', other.event.slug)).status).toBe(404);
    const guestOnManager = await createApp().request(
      `/api/manage/events/${access.event.id}/cover/1/wide-expanded/1x.jpeg`,
      { headers: { cookie: access.guest.cookie } },
      testEnv,
    );
    expect(guestOnManager.status).toBe(403);
    expect((await managerSlot('1', 'wide-expanded', '1x', 'jpeg', other.event.id)).status).toBe(403);

    await testEnv.DB.prepare(
      "UPDATE event_cover_render_sets SET state = 'retired' WHERE id = ?",
    ).bind(graph.renderSetId).run();
    expect((await guestSlot('1')).status).toBe(404);

    await resetDatabase();
    access = await eventAccess();
    const foreign = await eventAccess('Foreign Set');
    const foreignGraph = await fullActiveRenderSet(foreign);
    await testEnv.DB.exec('DROP TRIGGER event_cover_source_pointer_update');
    await testEnv.DB.prepare(`
      UPDATE events SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
      WHERE id = ?
    `).bind(
      '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
      coverMasterKey(foreign.event.id, foreignGraph.masterId),
      foreignGraph.renderSetId,
      access.event.id,
    ).run();
    expect((await guestSlot('1')).status).toBe(404);
  });

  it('honors disabled, expired, deleted, and manager-token access failures before resolving bytes', async () => {
    await fullActiveRenderSet(access);

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
    expect((await guestSlot('1')).status).toBe(401);

    await resetDatabase();
    access = await eventAccess();
    await fullActiveRenderSet(access);
    await testEnv.DB.prepare(
      "UPDATE event_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE event_id = ? AND role = 'guest'",
    ).bind(access.event.id).run();
    expect((await guestSlot('1')).status).toBe(401);

    await resetDatabase();
    access = await eventAccess();
    await fullActiveRenderSet(access);
    await testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
      .bind(now.toISOString(), access.event.id).run();
    expect((await guestSlot('1')).status).toBe(410);

    await resetDatabase();
    access = await eventAccess();
    await fullActiveRenderSet(access);
    await testEnv.DB.prepare(`
      UPDATE event_access_tokens SET expires_at = '2000-01-01T00:00:00.000Z'
      WHERE event_id = ? AND role = 'manager'
    `).bind(access.event.id).run();
    expect((await managerSlot('1')).status).toBe(410);
  });
});

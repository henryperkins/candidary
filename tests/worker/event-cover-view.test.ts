import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_COVER_PROFILES,
  type EventCoverPreparationView,
  coverProfile,
} from '../../shared/event-cover';
import { EventsRepository } from '../../worker/db/events';
import {
  guestCoverView,
  selectManagerEventCoverView,
} from '../../worker/http/event-cover-view';
import { coverMasterKey, coverRenderKey } from '../../worker/storage/event-cover-keys';
import { eventAccess, resetDatabase, testEnv } from './helpers';

const NOW = '2026-08-04T12:00:00.000Z';
const HEX_64 = 'a'.repeat(64);

async function reload(eventId: string) {
  return (await new EventsRepository(testEnv.DB).getById(eventId))!;
}

async function insertRenderObject(input: {
  id: string;
  eventId: string;
  renderSetId: string;
  profileId: (typeof EVENT_COVER_PROFILES)[number]['id'];
  density: '1x' | '2x';
  format: 'webp' | 'jpeg';
}) {
  const profile = coverProfile(input.profileId);
  const scale = input.density === '2x' ? 2 : 1;
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_render_objects (
      id, render_set_id, event_id, profile_id, density, format, object_key,
      content_type, byte_size, width, height, quality_rung, sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000, ?, ?, 1, ?, ?)
  `).bind(
    input.id,
    input.renderSetId,
    input.eventId,
    input.profileId,
    input.density,
    input.format,
    coverRenderKey(input.eventId, input.renderSetId, input.profileId, input.density, input.format),
    input.format === 'webp' ? 'image/webp' : 'image/jpeg',
    profile.width * scale,
    profile.height * scale,
    HEX_64,
    NOW,
  ).run();
}

async function publishUploadedCover(
  eventId: string,
  recipeJson = '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"film"}',
) {
  const masterId = 'master-current';
  const renderSetId = 'set-current';
  const masterKey = coverMasterKey(eventId, masterId);
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_masters (
      id, event_id, object_key, mime_type, byte_size, width, height, sha256,
      normalization_version, normalization_rung, created_at
    ) VALUES (?, ?, ?, 'image/webp', 100000, 2480, 1680, ?, 1, 1, ?)
  `).bind(masterId, eventId, masterKey, HEX_64, NOW).run();
  await testEnv.DB.prepare(`
    INSERT INTO event_cover_render_sets (
      id, event_id, master_id, recipe_json, recipe_sha256, state,
      required_slots, created_at
    ) VALUES (?, ?, ?, ?, ?, 'staging', 14, ?)
  `).bind(renderSetId, eventId, masterId, recipeJson, HEX_64, NOW).run();

  for (const profile of EVENT_COVER_PROFILES) {
    for (const format of ['webp', 'jpeg'] as const) {
      await insertRenderObject({
        id: `${profile.id}-1x-${format}`,
        eventId,
        renderSetId,
        profileId: profile.id,
        density: '1x',
        format,
      });
    }
  }
  for (const format of ['webp', 'jpeg'] as const) {
    await insertRenderObject({
      id: `compact-default-2x-${format}`,
      eventId,
      renderSetId,
      profileId: 'compact-default',
      density: '2x',
      format,
    });
  }
  await testEnv.DB.prepare(`
    UPDATE event_cover_render_sets
    SET state = 'active', manifest_sha256 = ?, published_revision = 1,
        ready_at = ?, published_at = ?
    WHERE id = ?
  `).bind(HEX_64, NOW, NOW, renderSetId).run();
  await testEnv.DB.prepare(`
    UPDATE events
    SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
    WHERE id = ?
  `).bind(
    JSON.stringify({
      version: 1,
      source: { kind: 'upload' },
      focus: { mode: 'auto' },
      effect: 'film',
    }),
    masterKey,
    renderSetId,
    eventId,
  ).run();
  return { masterId, renderSetId };
}

describe('nested event cover projection', () => {
  beforeEach(resetDatabase);

  it('projects none and strips the manager-only fields from the guest shape', async () => {
    const access = await eventAccess();
    const preparation: EventCoverPreparationView = {
      operationId: 'operation-a',
      status: 'preparing',
      completedSteps: 2,
      requiredSteps: 6,
      retryable: false,
      safeFailureCode: null,
      updatedAt: NOW,
    };

    const manager = await selectManagerEventCoverView(
      testEnv.DB,
      await reload(access.event.id),
      preparation,
    );
    expect(Object.keys(manager).sort()).toEqual([
      'available2xProfiles', 'config', 'hasCover', 'preparation', 'revision', 'surfaceTreatment',
    ]);
    expect(manager).toEqual({
      config: { version: 1, source: { kind: 'none' } },
      revision: 0,
      hasCover: false,
      available2xProfiles: [],
      surfaceTreatment: 'none',
      preparation,
    });

    const guest = guestCoverView(manager);
    expect(Object.keys(guest).sort()).toEqual([
      'available2xProfiles', 'hasCover', 'revision', 'surfaceTreatment',
    ]);
    expect(guest).toEqual({
      revision: 0,
      hasCover: false,
      available2xProfiles: [],
      surfaceTreatment: 'none',
    });
    expect(guest).not.toHaveProperty('config');
    expect(guest).not.toHaveProperty('preparation');
    expect(JSON.stringify(guest)).not.toContain('objectKey');
  });

  it('projects every preset 2x profile in ASCII-lexical order and derives its pinned treatment', async () => {
    const access = await eventAccess();
    for (const assetVersion of [1, 2] as const) {
      const config = {
        version: 1,
        source: { kind: 'preset' as const, presetId: 'candlelit-grain' as const, assetVersion },
        effect: 'film' as const,
      } as const;
      await testEnv.DB.prepare(`
        UPDATE events SET cover_config = ?, cover_revision = ? WHERE id = ?
      `).bind(JSON.stringify(config), assetVersion, access.event.id).run();
      expect(await selectManagerEventCoverView(
        testEnv.DB, await reload(access.event.id), null,
      )).toEqual({
        config,
        revision: assetVersion,
        hasCover: true,
        available2xProfiles: [
          'compact-default',
          'compact-expanded',
          'framed-default',
          'short-lookup',
          'standard-default',
          'wide-expanded',
        ],
        surfaceTreatment: `film-grain-v${assetVersion}`,
        preparation: null,
      });
    }
  });

  it('derives upload Film treatment from the active set recipe version', async () => {
    const access = await eventAccess();
    await publishUploadedCover(access.event.id,
      '{"version":2,"config":{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"film"},"tonalEffectVersion":2}');

    const manager = await selectManagerEventCoverView(
      testEnv.DB, await reload(access.event.id), null,
    );
    expect(manager.surfaceTreatment).toBe('film-grain-v2');
  });

  it('advertises only paired 2x formats from the current active set', async () => {
    const access = await eventAccess();
    const { masterId, renderSetId } = await publishUploadedCover(access.event.id);

    // Fault-inject inventory that 0014 prevents: one current-set singleton and
    // its apparent mate on a different set. Neither may become capability.
    await testEnv.DB.prepare('DROP TRIGGER event_cover_render_object_manifest_insert').run();
    await insertRenderObject({
      id: 'wide-expanded-current-webp',
      eventId: access.event.id,
      renderSetId,
      profileId: 'wide-expanded',
      density: '2x',
      format: 'webp',
    });
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_render_sets (
        id, event_id, master_id, recipe_json, recipe_sha256, state,
        required_slots, created_at
      ) VALUES ('set-other', ?, ?, '{}', ?, 'staging', 12, ?)
    `).bind(access.event.id, masterId, HEX_64, NOW).run();
    await insertRenderObject({
      id: 'wide-expanded-other-jpeg',
      eventId: access.event.id,
      renderSetId: 'set-other',
      profileId: 'wide-expanded',
      density: '2x',
      format: 'jpeg',
    });

    const manager = await selectManagerEventCoverView(
      testEnv.DB,
      await reload(access.event.id),
      null,
    );
    expect(manager.available2xProfiles).toEqual(['compact-default']);
    expect(manager.hasCover).toBe(true);
    expect(manager.surfaceTreatment).toBe('film-grain-v1');
  });

  it('emits one sanitized observation and throws instead of repairing an impossible graph', async () => {
    const access = await eventAccess();
    const event = await reload(access.event.id);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(selectManagerEventCoverView(
      testEnv.DB,
      { ...event, coverConfig: '{"version":2,"source":{"kind":"none"}}' },
      null,
    )).rejects.toThrow('Event cover projection invariant failed.');

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(JSON.stringify({
      event: 'cover_projection_invariant_failed',
      reason: 'stored-config-invalid',
    }));
    expect(error.mock.calls[0]?.[0]).not.toContain(access.event.id);
    error.mockRestore();
  });
});

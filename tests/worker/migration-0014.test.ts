import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { EVENT_COVER_PROFILES } from '../../shared/event-cover';
import { migrationOnly, migrationsUpTo } from './helpers';

const NOW = '2026-08-10T00:00:00.000Z';
const HEX_64 = 'a'.repeat(64);
const NONE = '{"version":1,"source":{"kind":"none"}}';
const UPLOAD = '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}';
const PHASE_3_TRIGGERS = [
  'event_cover_master_live_reference_delete',
  'event_cover_render_object_manifest_delete',
  'event_cover_render_object_manifest_insert',
  'event_cover_render_object_manifest_update',
  'event_cover_render_set_live_reference_delete',
  'event_cover_render_set_manifest_insert',
  'event_cover_render_set_manifest_update',
  'event_cover_source_pointer_insert',
  'event_cover_source_pointer_update',
] as const;

async function seedEvent(id = 'event-a', slug = 'event-a', legacyKey: string | null = null) {
  await env.DB.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message, cover_object_key,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?, ?)
  `).bind(id, slug, legacyKey, NOW, NOW, NOW, NOW).run();
}

async function phase3TriggerNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'event_cover_%'
    ORDER BY name
  `).all<{ name: string }>();
  return results.map(({ name }) => name);
}

async function seedCompleteStagingSet(eventId = 'event-a') {
  const masterId = `master-${eventId}`;
  const setId = `set-${eventId}`;
  const masterKey = `events/${eventId}/cover/masters/${masterId}.webp`;
  await env.DB.prepare(`
    INSERT INTO event_cover_masters (
      id, event_id, object_key, mime_type, byte_size, width, height, sha256,
      normalization_version, normalization_rung, auto_focus_x, auto_focus_y,
      composition_model_version, created_at
    ) VALUES (?, ?, ?, 'image/webp', 100, 2400, 1600, ?, 1, 1, 0.5, 0.5, 1, ?)
  `).bind(masterId, eventId, masterKey, HEX_64, NOW).run();
  await env.DB.prepare(`
    INSERT INTO event_cover_render_sets (
      id, event_id, master_id, recipe_json, recipe_sha256, state,
      required_slots, created_at
    ) VALUES (?, ?, ?, ?, ?, 'staging', 12, ?)
  `).bind(setId, eventId, masterId, UPLOAD, HEX_64, NOW).run();
  const statements = EVENT_COVER_PROFILES.flatMap((profile) => (
    ['webp', 'jpeg'] as const
  ).map((format) => env.DB.prepare(`
    INSERT INTO event_cover_render_objects (
      id, render_set_id, event_id, profile_id, density, format, object_key,
      content_type, byte_size, width, height, quality_rung, sha256, created_at
    ) VALUES (?, ?, ?, ?, '1x', ?, ?, ?, 100, ?, ?, 1, ?, ?)
  `).bind(
    `${setId}-${profile.id}-${format}`,
    setId,
    eventId,
    profile.id,
    format,
    `events/${eventId}/cover/rendered/${setId}/${profile.id}-1x.${format}`,
    format === 'webp' ? 'image/webp' : 'image/jpeg',
    profile.width,
    profile.height,
    HEX_64,
    NOW,
  )));
  await env.DB.batch(statements);
  return { masterId, setId, masterKey };
}

describe('migration 0014 cover invariants', () => {
  beforeEach(reset);

  it('rejects a populated legacy database atomically', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0014'));
    await seedEvent('event-legacy', 'legacy', 'events/event-legacy/cover/legacy.jpg');

    await expect(applyD1Migrations(env.DB, [migrationOnly('0014')])).rejects.toThrow();

    expect(await phase3TriggerNames()).toEqual([]);
    expect(await env.DB.prepare(`
      SELECT name FROM sqlite_master WHERE name = '_event_cover_0014_proof_guard'
    `).first()).toBeNull();
    expect(await env.DB.prepare(`
      SELECT name FROM d1_migrations WHERE name = '0014_event_cover_invariants.sql'
    `).first()).toBeNull();
  });

  it('installs exactly the nine phase-3 triggers on a fresh database', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0014'), migrationOnly('0014')]);
    expect(await phase3TriggerNames()).toEqual(PHASE_3_TRIGGERS);
  });

  it('permits a complete set to become active before the event selects it', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0014'), migrationOnly('0014')]);
    await seedEvent();
    const graph = await seedCompleteStagingSet();

    await expect(env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'active', manifest_sha256 = ?, ready_at = ?,
          published_revision = 1, published_at = ?
      WHERE id = ?
    `).bind(HEX_64, NOW, NOW, graph.setId).run()).resolves.toBeDefined();
    await expect(env.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
      WHERE id = 'event-a'
    `).bind(UPLOAD, graph.masterKey, graph.setId).run()).resolves.toBeDefined();
  });

  it('rejects malformed semantic sources and mutation beneath a frozen set', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0014'), migrationOnly('0014')]);
    await seedEvent();
    const graph = await seedCompleteStagingSet();
    await env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'active', manifest_sha256 = ?, ready_at = ?,
          published_revision = 1, published_at = ?
      WHERE id = ?
    `).bind(HEX_64, NOW, NOW, graph.setId).run();
    await env.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
      WHERE id = 'event-a'
    `).bind(UPLOAD, graph.masterKey, graph.setId).run();

    await expect(env.DB.prepare(`UPDATE events SET cover_config = '{}' WHERE id = 'event-a'`).run())
      .rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE event_cover_render_objects SET byte_size = byte_size + 1
      WHERE render_set_id = ?
    `).bind(graph.setId).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      DELETE FROM event_cover_render_objects WHERE render_set_id = ?
    `).bind(graph.setId).run()).rejects.toThrow();
  });

  it('allows protected deletion only after the exact relational purge handoff', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0014'), migrationOnly('0014')]);
    await seedEvent();
    const graph = await seedCompleteStagingSet();
    await env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'active', manifest_sha256 = ?, ready_at = ?,
          published_revision = 1, published_at = ?
      WHERE id = ?
    `).bind(HEX_64, NOW, NOW, graph.setId).run();
    await env.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
      WHERE id = 'event-a'
    `).bind(UPLOAD, graph.masterKey, graph.setId).run();
    await env.DB.prepare(`UPDATE events SET deleted_at = ? WHERE id = 'event-a'`).bind(NOW).run();

    await expect(env.DB.prepare(`DELETE FROM event_cover_render_objects WHERE render_set_id = ?`)
      .bind(graph.setId).run()).rejects.toThrow();

    await env.DB.prepare(`
      INSERT INTO event_cover_purge_progress (event_id, phase, created_at, updated_at)
      VALUES ('event-a', 'relational', ?, ?)
    `).bind(NOW, NOW).run();
    await env.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = NULL, cover_render_set_id = NULL
      WHERE id = 'event-a'
    `).bind(NONE).run();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM event_cover_render_objects WHERE render_set_id = ?`).bind(graph.setId),
      env.DB.prepare(`DELETE FROM event_cover_render_sets WHERE id = ?`).bind(graph.setId),
      env.DB.prepare(`DELETE FROM event_cover_masters WHERE id = ?`).bind(graph.masterId),
    ]);
    expect(await env.DB.prepare(`SELECT id FROM event_cover_masters WHERE id = ?`)
      .bind(graph.masterId).first()).toBeNull();
  });
});

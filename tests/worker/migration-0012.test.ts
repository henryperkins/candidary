import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  EVENT_COVER_TABLES,
  migrationOnly,
  migrationsUpTo,
  orderedMigrations,
  seedEventCoverGraph,
} from './helpers';

const now = '2026-08-04T00:00:00.000Z';
const HEX_64 = 'a'.repeat(64);
const CANONICAL_NONE = '{"version":1,"source":{"kind":"none"}}';
const LEGACY_KEY = 'events/event-legacy/cover/9f1c-porch.jpg';

/** The three triggers this schema had before 0012, and must still have after. */
const EXISTING_TRIGGERS = [
  'events_rsvp_deadline_insert',
  'events_rsvp_deadline_update',
  'media_stamp_stored_at_compat',
];

async function seedEvent(id: string, slug: string, coverObjectKey: string | null): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message, cover_object_key,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?, ?)
  `).bind(id, slug, coverObjectKey, now, now, now, now).run();
}

async function columnNames(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
    .bind(table).all<{ name: string }>();
  return results.map((row) => row.name);
}

async function schemaSnapshot(): Promise<{ type: string; name: string; sql: string | null }[]> {
  const { results } = await env.DB.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all<{ type: string; name: string; sql: string | null }>();
  return results;
}

/** Applies 0001-0011, seeds a populated legacy database, then applies 0012 alone. */
async function migrateOverPopulatedLegacy(): Promise<void> {
  await applyD1Migrations(env.DB, migrationsUpTo('0012'));
  await seedEvent('event-legacy', 'legacy-slug', LEGACY_KEY);
  await seedEvent('event-plain', 'plain-slug', null);
  await applyD1Migrations(env.DB, [migrationOnly('0012')]);
}

describe('migration 0012 over a populated legacy database', () => {
  beforeEach(async () => {
    await reset();
    await migrateOverPopulatedLegacy();
  });

  it('leaves every existing row intact and defaults the three new columns', async () => {
    const { results } = await env.DB.prepare(`
      SELECT id, cover_object_key, cover_config, cover_revision, cover_render_set_id
      FROM events ORDER BY id
    `).all<{
      id: string;
      cover_object_key: string | null;
      cover_config: string;
      cover_revision: number;
      cover_render_set_id: string | null;
    }>();

    expect(results).toEqual([
      {
        id: 'event-legacy',
        // Untouched: 0012 is additive and the backfill is a separate release phase.
        cover_object_key: LEGACY_KEY,
        cover_config: CANONICAL_NONE,
        cover_revision: 0,
        cover_render_set_id: null,
      },
      {
        id: 'event-plain',
        cover_object_key: null,
        cover_config: CANONICAL_NONE,
        cover_revision: 0,
        cover_render_set_id: null,
      },
    ]);
  });

  it('appends exactly three columns, last and in order', async () => {
    const names = await columnNames('events');
    expect(names).toHaveLength(29);
    expect(names.slice(26)).toEqual(['cover_config', 'cover_revision', 'cover_render_set_id']);
    // The pre-0012 tail is unmoved, which is what `verify:fresh-d1` compares by
    // ordinal position.
    expect(names[25]).toBe('photos_open_from');
  });

  it('holds the cover_config CHECK constraints', async () => {
    const set = (value: string) => env.DB.prepare('UPDATE events SET cover_config = ? WHERE id = ?')
      .bind(value, 'event-plain').run();

    await expect(set('x'.repeat(4097))).rejects.toThrow();
    await expect(set('{not json')).rejects.toThrow();
    await expect(set('[]')).rejects.toThrow();
    await expect(set('"a string"')).rejects.toThrow();
    // 4096 exactly is legal, and so is any other JSON object.
    const padded = JSON.stringify({ version: 1, source: { kind: 'none' }, pad: 'p'.repeat(4040) });
    expect(padded.length).toBeLessThanOrEqual(4096);
    await expect(set(padded)).resolves.toBeDefined();
  });

  it('holds the cover_revision CHECK constraints', async () => {
    const set = (value: number) => env.DB.prepare('UPDATE events SET cover_revision = ? WHERE id = ?')
      .bind(value, 'event-plain').run();
    await expect(set(-1)).rejects.toThrow();
    await expect(set(1.5)).rejects.toThrow();
    await expect(set(7)).resolves.toBeDefined();
  });

  it('creates exactly the twelve cover tables', async () => {
    const { results } = await env.DB.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'event\\_cover\\_%' ESCAPE '\\'
      ORDER BY name
    `).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual([
      'event_cover_backfill_jobs',
      'event_cover_backfill_runs',
      'event_cover_draft_previews',
      'event_cover_drafts',
      'event_cover_masters',
      'event_cover_publish_receipts',
      'event_cover_purge_progress',
      'event_cover_rate_events',
      'event_cover_render_objects',
      'event_cover_render_sets',
      'event_cover_retired_legacy_objects',
      'event_cover_workflow_fences',
    ]);
  });

  it('adds no trigger', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
    ).all<{ name: string }>();
    // 0013's invariant triggers are deliberately absent from this candidate.
    expect(results.map((row) => row.name).sort()).toEqual([...EXISTING_TRIGGERS].sort());
  });

  it('refuses an event_id naming no event in every table that has one', async () => {
    const ids = await seedEventCoverGraph(env.DB, 'event-legacy', now);
    const orphan = 'event-does-not-exist';

    const attempts: Record<(typeof EVENT_COVER_TABLES)[number], () => Promise<unknown>> = {
      event_cover_masters: () => env.DB.prepare(`
        INSERT INTO event_cover_masters (id, event_id, object_key, mime_type, byte_size,
          width, height, sha256, normalization_version, normalization_rung, created_at)
        VALUES ('m-orphan', ?, 'events/x/cover/masters/m.webp', 'image/webp', 1, 700, 500, ?, 1, 1, ?)
      `).bind(orphan, HEX_64, now).run(),
      event_cover_drafts: () => env.DB.prepare(`
        INSERT INTO event_cover_drafts (id, event_id, source, state, draft_intent_id,
          request_sha256, created_at, updated_at, expires_at)
        VALUES ('d-orphan', ?, 'new_upload', 'reserved', 'i-orphan', ?, ?, ?, ?)
      `).bind(orphan, HEX_64, now, now, now).run(),
      event_cover_draft_previews: () => env.DB.prepare(`
        INSERT INTO event_cover_draft_previews (id, draft_id, event_id, effect_id,
          recipe_version, state, created_at, updated_at)
        VALUES ('p-orphan', ?, ?, 'warm', 1, 'rendering', ?, ?)
      `).bind(ids.draftId, orphan, now, now).run(),
      event_cover_render_sets: () => env.DB.prepare(`
        INSERT INTO event_cover_render_sets (id, event_id, master_id, recipe_json,
          recipe_sha256, state, required_slots, created_at)
        VALUES ('s-orphan', ?, ?, '{}', ?, 'staging', 12, ?)
      `).bind(orphan, ids.masterId, HEX_64, now).run(),
      event_cover_render_objects: () => env.DB.prepare(`
        INSERT INTO event_cover_render_objects (id, render_set_id, event_id, profile_id,
          density, format, object_key, content_type, byte_size, width, height,
          quality_rung, sha256, created_at)
        VALUES ('o-orphan', ?, ?, 'short-lookup', '1x', 'webp', 'events/x/o', 'image/webp', 1, 360, 168, 1, ?, ?)
      `).bind(ids.renderSetId, orphan, HEX_64, now).run(),
      event_cover_publish_receipts: () => env.DB.prepare(`
        INSERT INTO event_cover_publish_receipts (event_id, operation_id, request_sha256,
          action, expected_revision, status, dependency_versions_json, dispatch_state,
          created_at, updated_at, expires_at)
        VALUES (?, 'op-orphan', ?, 'remove', 0, 'applied', '{}', 'confirmed', ?, ?, ?)
      `).bind(orphan, HEX_64, now, now, now).run(),
      event_cover_rate_events: () => env.DB.prepare(`
        INSERT INTO event_cover_rate_events (id, event_id, action, replay_key,
          request_sha256, window_start, created_at, expires_at)
        VALUES ('r-orphan', ?, 'preview', 'k-orphan', ?, 0, ?, ?)
      `).bind(orphan, HEX_64, now, now).run(),
      event_cover_retired_legacy_objects: () => env.DB.prepare(`
        INSERT INTO event_cover_retired_legacy_objects (id, event_id, object_key,
          key_fingerprint, reason, retired_at, cleanup_after)
        VALUES ('l-orphan', ?, 'events/x/legacy.jpg', ?, 'removed', ?, ?)
      `).bind(orphan, HEX_64, now, now).run(),
      event_cover_purge_progress: () => env.DB.prepare(`
        INSERT INTO event_cover_purge_progress (event_id, phase, created_at, updated_at)
        VALUES (?, 'r2', ?, ?)
      `).bind(orphan, now, now).run(),
      event_cover_backfill_jobs: () => env.DB.prepare(`
        INSERT INTO event_cover_backfill_jobs (id, run_id, event_id, expected_revision,
          legacy_key_fingerprint, workflow_instance_id, dispatch_state, status,
          dependency_versions_json, created_at, updated_at)
        VALUES ('j-orphan', ?, ?, 0, ?, 'w-orphan', 'pending', 'queued', '{}', ?, ?)
      `).bind(ids.runId, orphan, HEX_64, now, now).run(),
    };

    for (const table of EVENT_COVER_TABLES) {
      await expect(attempts[table]()).rejects.toThrow();
    }
  });

  // The behavior Task 4 exists to accommodate. Every existing `REFERENCES
  // events(id)` in this schema cascades; these deliberately do not, so the
  // scheduled purge must delete cover rows itself or fail forever.
  it('refuses to delete an event that still owns cover rows', async () => {
    await seedEventCoverGraph(env.DB, 'event-legacy', now);
    await expect(
      env.DB.prepare('DELETE FROM events WHERE id = ?').bind('event-legacy').run(),
    ).rejects.toThrow();
    // An event owning nothing is unaffected.
    await expect(
      env.DB.prepare('DELETE FROM events WHERE id = ?').bind('event-plain').run(),
    ).resolves.toBeDefined();
  });

  it('permits at most one active render set per event', async () => {
    const ids = await seedEventCoverGraph(env.DB, 'event-legacy', now);
    const second = env.DB.prepare(`
      INSERT INTO event_cover_render_sets (id, event_id, master_id, recipe_json,
        recipe_sha256, state, required_slots, manifest_sha256, created_at)
      VALUES ('set-second', 'event-legacy', ?, '{}', ?, 'active', 12, ?, ?)
    `).bind(ids.masterId, HEX_64, HEX_64, now);
    await expect(second.run()).rejects.toThrow();

    // Every non-active state is unconstrained, and a second event may activate.
    await expect(env.DB.prepare(`
      INSERT INTO event_cover_render_sets (id, event_id, master_id, recipe_json,
        recipe_sha256, state, required_slots, created_at)
      VALUES ('set-staging', 'event-legacy', ?, '{}', ?, 'staging', 12, ?)
    `).bind(ids.masterId, HEX_64, now).run()).resolves.toBeDefined();
    await expect(env.DB.prepare(`
      INSERT INTO event_cover_render_sets (id, event_id, master_id, recipe_json,
        recipe_sha256, state, required_slots, created_at)
      VALUES ('set-retired', 'event-legacy', ?, '{}', ?, 'retired', 12, ?)
    `).bind(ids.masterId, HEX_64, now).run()).resolves.toBeDefined();
  });

  it('permits at most one preparing receipt per event, and frees it when retry ends', async () => {
    const insertReceipt = (
      operationId: string,
      status: string,
      retryable: number,
    ) => env.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (event_id, operation_id, request_sha256,
        action, expected_revision, status, dependency_versions_json, retryable,
        dispatch_state, created_at, updated_at, expires_at)
      VALUES ('event-legacy', ?, ?, 'publish', 0, ?, '{}', ?, 'pending', ?, ?, ?)
    `).bind(operationId, HEX_64, status, retryable, now, now, now).run();

    await expect(insertReceipt('op-1', 'queued', 0)).resolves.toBeDefined();
    for (const blocked of ['queued', 'rendering', 'finalizing']) {
      await expect(insertReceipt(`op-${blocked}-x`, blocked, 0)).rejects.toThrow();
    }
    // A retryable failure still blocks: its restart window is live.
    await env.DB.prepare(`UPDATE event_cover_publish_receipts SET status = 'failed', retryable = 1
      WHERE operation_id = 'op-1'`).run();
    await expect(insertReceipt('op-2', 'queued', 0)).rejects.toThrow();
    // Expiry clears `retryable` before the row stops blocking a competitor.
    await env.DB.prepare(`UPDATE event_cover_publish_receipts SET retryable = 0
      WHERE operation_id = 'op-1'`).run();
    await expect(insertReceipt('op-3', 'queued', 0)).resolves.toBeDefined();
    // Terminal states never block.
    await env.DB.prepare(`UPDATE event_cover_publish_receipts SET status = 'applied'
      WHERE operation_id = 'op-3'`).run();
    await expect(insertReceipt('op-4', 'conflict', 0)).resolves.toBeDefined();
  });

  it('rejects each duplicate compound key', async () => {
    const ids = await seedEventCoverGraph(env.DB, 'event-legacy', now);
    const draftIntentId = (await env.DB.prepare(
      'SELECT draft_intent_id AS v FROM event_cover_drafts WHERE id = ?',
    ).bind(ids.draftId).first<{ v: string }>())!.v;

    // (event_id, draft_intent_id)
    await expect(env.DB.prepare(`
      INSERT INTO event_cover_drafts (id, event_id, source, state, draft_intent_id,
        request_sha256, created_at, updated_at, expires_at)
      VALUES ('d-dupe', 'event-legacy', 'new_upload', 'reserved', ?, ?, ?, ?, ?)
    `).bind(draftIntentId, HEX_64, now, now, now).run()).rejects.toThrow();

    // (draft_id, effect_id, recipe_version)
    await expect(env.DB.prepare(`
      INSERT INTO event_cover_draft_previews (id, draft_id, event_id, effect_id,
        recipe_version, state, created_at, updated_at)
      VALUES ('p-dupe', ?, 'event-legacy', 'natural', 1, 'rendering', ?, ?)
    `).bind(ids.draftId, now, now).run()).rejects.toThrow();

    // (render_set_id, profile_id, density, format)
    await expect(env.DB.prepare(`
      INSERT INTO event_cover_render_objects (id, render_set_id, event_id, profile_id,
        density, format, object_key, content_type, byte_size, width, height,
        quality_rung, sha256, created_at)
      VALUES ('o-dupe', ?, 'event-legacy', 'wide-expanded', '1x', 'jpeg', 'events/x/dupe',
        'image/jpeg', 1, 620, 420, 1, ?, ?)
    `).bind(ids.renderSetId, HEX_64, now).run()).rejects.toThrow();

    // (event_id, operation_id) — the receipts primary key.
    await expect(env.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (event_id, operation_id, request_sha256,
        action, expected_revision, status, dependency_versions_json, dispatch_state,
        created_at, updated_at, expires_at)
      VALUES ('event-legacy', ?, ?, 'remove', 0, 'applied', '{}', 'confirmed', ?, ?, ?)
    `).bind(ids.operationId, HEX_64, now, now, now).run()).rejects.toThrow();

    // (event_id, action, replay_key)
    await expect(env.DB.prepare(`
      INSERT INTO event_cover_rate_events (id, event_id, action, replay_key,
        request_sha256, window_start, created_at, expires_at)
      VALUES ('r-dupe', 'event-legacy', 'publication', ?, ?, 0, ?, ?)
    `).bind(ids.operationId, HEX_64, now, now).run()).rejects.toThrow();

    // (run_id, event_id)
    await expect(env.DB.prepare(`
      INSERT INTO event_cover_backfill_jobs (id, run_id, event_id, expected_revision,
        legacy_key_fingerprint, workflow_instance_id, dispatch_state, status,
        dependency_versions_json, created_at, updated_at)
      VALUES ('j-dupe', ?, 'event-legacy', 0, ?, 'w-dupe', 'pending', 'queued', '{}', ?, ?)
    `).bind(ids.runId, HEX_64, now, now).run()).rejects.toThrow();
  });

  it('rejects a duplicate object key and a duplicate workflow instance ID', async () => {
    const ids = await seedEventCoverGraph(env.DB, 'event-legacy', now);
    const masterKey = (await env.DB.prepare('SELECT object_key AS v FROM event_cover_masters WHERE id = ?')
      .bind(ids.masterId).first<{ v: string }>())!.v;
    const renderKey = (await env.DB.prepare('SELECT object_key AS v FROM event_cover_render_objects WHERE id = ?')
      .bind(ids.renderObjectId).first<{ v: string }>())!.v;

    await expect(env.DB.prepare(`
      INSERT INTO event_cover_masters (id, event_id, object_key, mime_type, byte_size,
        width, height, sha256, normalization_version, normalization_rung, created_at)
      VALUES ('m-dupe', 'event-legacy', ?, 'image/webp', 1, 700, 500, ?, 1, 1, ?)
    `).bind(masterKey, HEX_64, now).run()).rejects.toThrow();

    await expect(env.DB.prepare(`
      INSERT INTO event_cover_render_objects (id, render_set_id, event_id, profile_id,
        density, format, object_key, content_type, byte_size, width, height,
        quality_rung, sha256, created_at)
      VALUES ('o-key-dupe', ?, 'event-legacy', 'short-lookup', '1x', 'webp', ?,
        'image/webp', 1, 360, 168, 1, ?, ?)
    `).bind(ids.renderSetId, renderKey, HEX_64, now).run()).rejects.toThrow();

    // A retained instance ID can never be reused for a competing operation.
    await expect(env.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (event_id, operation_id, request_sha256,
        action, expected_revision, status, workflow_instance_id,
        dependency_versions_json, dispatch_state, created_at, updated_at, expires_at)
      VALUES ('event-plain', 'op-other', ?, 'publish', 0, 'applied', ?, '{}', 'confirmed', ?, ?, ?)
    `).bind(HEX_64, ids.workflowInstanceId, now, now, now).run()).rejects.toThrow();
  });

  // The fence has to survive the event it protected, or a late dispatcher could
  // do cover work for a purged event.
  it('lets a workflow fence outlive its event', async () => {
    await env.DB.prepare(`
      INSERT INTO event_cover_workflow_fences (workflow_binding, workflow_instance_id,
        event_id, dispatch_generation, state, created_at, updated_at, expires_at)
      VALUES ('COVER_RENDER_WORKFLOW', 'instance-orphan', 'event-plain', 0, 'deletion-blocked', ?, ?, ?)
    `).bind(now, now, now).run();
    await env.DB.prepare('DELETE FROM events WHERE id = ?').bind('event-plain').run();
    const survivor = await env.DB.prepare(
      'SELECT state AS v FROM event_cover_workflow_fences WHERE workflow_instance_id = ?',
    ).bind('instance-orphan').first<{ v: string }>();
    expect(survivor?.v).toBe('deletion-blocked');
  });
});

describe('migration 0012 on an empty database', () => {
  it('reaches the identical schema whether or not legacy rows were present', async () => {
    await reset();
    await migrateOverPopulatedLegacy();
    const overLegacy = await schemaSnapshot();

    await reset();
    await applyD1Migrations(env.DB, orderedMigrations);
    const fromEmpty = await schemaSnapshot();

    expect(fromEmpty).toEqual(overLegacy);
    expect(fromEmpty.filter((entry) => entry.type === 'table' && entry.name.startsWith('event_cover_')))
      .toHaveLength(12);
  });
});

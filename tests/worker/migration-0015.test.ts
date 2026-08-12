import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_GUESTBOOK_PROMPT,
  GUESTBOOK_SOURCE_RANK,
  MAX_GUESTBOOK_PROMPT_LENGTH,
} from '../../shared/constants';
import { migrationOnly, migrationsUpTo } from './helpers';

const NOW = '2026-08-12T00:00:00.000Z';

async function seedEvent(id = 'event-a') {
  await env.DB.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
  `).bind(id, id, NOW, NOW, NOW, NOW).run();
}

describe('migration 0015 curated private guestbook', () => {
  beforeEach(reset);

  it('gives an existing 0014 event the approved prompt', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0015'));
    await seedEvent();

    await applyD1Migrations(env.DB, [migrationOnly('0015')]);

    const event = await env.DB.prepare(`
      SELECT guestbook_prompt FROM events WHERE id = 'event-a'
    `).first<{ guestbook_prompt: string }>();
    expect(event?.guestbook_prompt).toBe(DEFAULT_GUESTBOOK_PROMPT);
  });

  it('enforces the TypeScript prompt limit and trims at the database boundary', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0015'), migrationOnly('0015')]);
    await seedEvent();

    await expect(env.DB.prepare(`UPDATE events SET guestbook_prompt = '   ' WHERE id = 'event-a'`).run())
      .rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE events SET guestbook_prompt = ? WHERE id = 'event-a'`)
      .bind('g'.repeat(MAX_GUESTBOOK_PROMPT_LENGTH + 1)).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE events SET guestbook_prompt = ? WHERE id = 'event-a'`)
      .bind('g'.repeat(MAX_GUESTBOOK_PROMPT_LENGTH)).run()).resolves.toBeDefined();
  });

  it('installs the bounded rate, purge, export metadata, snapshot, and ordering schema', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0015'), migrationOnly('0015')]);

    const tables = await env.DB.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'guest_message_rate_events',
        'guest_message_purge_receipts',
        'export_guestbook_entries'
      ) ORDER BY name
    `).all<{ name: string }>();
    expect(tables.results.map(({ name }) => name)).toEqual([
      'export_guestbook_entries',
      'guest_message_purge_receipts',
      'guest_message_rate_events',
    ]);

    const exportColumns = await env.DB.prepare(`PRAGMA table_info(export_jobs)`)
      .all<{ name: string }>();
    expect(exportColumns.results.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'guestbook_html_object_key', 'guestbook_html_bytes', 'guestbook_html_sha256',
      'guestbook_csv_object_key', 'guestbook_csv_bytes', 'guestbook_csv_sha256',
      'guestbook_entry_count', 'guestbook_shared_count', 'guestbook_event_name',
      'guestbook_event_date', 'guestbook_event_timezone', 'guestbook_prompt',
      'guestbook_gallery_visible',
    ]));

    const indexes = await env.DB.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'guestbook_%'
      ORDER BY name
    `).all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual([
      'guestbook_export_render_order',
      'guestbook_notes_event_feed',
      'guestbook_notes_event_owner',
      'guestbook_rate_event_ip_window',
      'guestbook_rate_event_session_window',
    ]);

    expect(GUESTBOOK_SOURCE_RANK).toEqual({ guest_note: 0, photo_caption: 1 });
    await seedEvent();
    await env.DB.prepare(`
      INSERT INTO export_jobs (
        id, event_id, state, snapshot_at, media_count, total_bytes, created_at
      ) VALUES ('export-a', 'event-a', 'queued', ?, 0, 0, ?)
    `).bind(NOW, NOW).run();
    await expect(env.DB.prepare(`
      INSERT INTO export_guestbook_entries (
        export_job_id, source, source_id, source_rank, body, created_at,
        source_state, guest_visibility, included_in_keepsake
      ) VALUES ('export-a', 'guest_note', 'message-a', 2, 'Wish', ?,
        'approved', 'shared', 1)
    `).bind(NOW).run()).rejects.toThrow();
  });
});

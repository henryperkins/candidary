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

  it('enforces the TypeScript prompt length boundaries at the database boundary', async () => {
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
        'export_guestbook_entries',
        'export_media_entries'
      ) ORDER BY name
    `).all<{ name: string }>();
    expect(tables.results.map(({ name }) => name)).toEqual([
      'export_guestbook_entries',
      'export_media_entries',
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

    const mediaSnapshotColumns = await env.DB.prepare(`PRAGMA table_info(export_media_entries)`)
      .all<{ name: string }>();
    expect(mediaSnapshotColumns.results.map(({ name }) => name)).toEqual([
      'export_job_id', 'media_id', 'object_key', 'object_bucket_generation',
      'original_filename', 'mime_type',
      'declared_byte_size', 'byte_size', 'width', 'height', 'guest_name', 'caption',
      'publication_status', 'created_at', 'published_at',
    ]);
    const mediaSnapshotForeignKeys = await env.DB.prepare(`PRAGMA foreign_key_list(export_media_entries)`)
      .all<{ table: string; from: string; on_delete: string }>();
    expect(mediaSnapshotForeignKeys.results).toEqual([expect.objectContaining({
      table: 'export_jobs', from: 'export_job_id', on_delete: 'CASCADE',
    })]);

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

  it('installs explicit dual-bucket routing and permanent scanner state', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0015'), migrationOnly('0015')]);

    const mediaColumns = await env.DB.prepare(`PRAGMA table_info(media)`).all<{
      name: string; notnull: number; dflt_value: string | null;
    }>();
    expect(mediaColumns.results).toContainEqual(expect.objectContaining({
      name: 'object_bucket_generation', notnull: 1, dflt_value: "'legacy'",
    }));
    const promotionColumns = await env.DB.prepare(`PRAGMA table_info(media_object_promotions)`)
      .all<{ name: string; notnull: number; dflt_value: string | null }>();
    expect(promotionColumns.results).toContainEqual(expect.objectContaining({
      name: 'source_bucket_generation', notnull: 1, dflt_value: "'legacy'",
    }));
    expect(promotionColumns.results).toContainEqual(expect.objectContaining({
      name: 'final_bucket_generation', notnull: 1, dflt_value: "'canonical'",
    }));
    expect(promotionColumns.results.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'source_width',
      'source_height',
      'final_etag',
      'target_verified_at',
    ]));

    expect(await env.DB.prepare(`
      SELECT singleton, cursor, epoch, last_completed_at
      FROM legacy_media_scan_state
    `).first()).toEqual({ singleton: 1, cursor: null, epoch: 0, last_completed_at: null });
    expect((await env.DB.prepare(`PRAGMA foreign_key_list(legacy_media_scan_state)`).all()).results)
      .toEqual([]);
    expect((await env.DB.prepare(`PRAGMA foreign_key_list(legacy_media_scan_quarantine)`).all()).results)
      .toEqual([]);

    await env.DB.prepare(`
      INSERT INTO media_object_write_tombstones (
        bucket_generation, object_key, event_id, media_id, object_kind,
        next_check_at, created_at, updated_at
      ) VALUES
        ('legacy', 'events/e/media/final/m', 'e', 'm', 'final', ?, ?, ?),
        ('canonical', 'events/e/media/final/m', 'e', 'm', 'final', ?, ?, ?)
    `).bind(NOW, NOW, NOW, NOW, NOW, NOW).run();
    expect(await env.DB.prepare(`
      SELECT count(*) AS count FROM media_object_write_tombstones
      WHERE object_key = 'events/e/media/final/m'
    `).first()).toEqual({ count: 2 });
  });

  it('seeds and maintains durable promotion inventory without stealing active claims', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0015'));
    await seedEvent();
    await env.DB.prepare(`
      INSERT INTO event_access_tokens (
        id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
      ) VALUES ('token-a', 'event-a', 'guest', 'token-secret', 'ciphertext', ?, ?)
    `).bind(NOW, NOW).run();
    await env.DB.prepare(`
      INSERT INTO event_sessions (
        id, secret_digest, event_id, access_token_id, role, csrf_digest,
        expires_at, created_at
      ) VALUES (
        'session-a', 'session-secret', 'event-a', 'token-a', 'guest', 'csrf', ?, ?
      )
    `).bind(NOW, NOW).run();
    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename,
        mime_type, declared_byte_size, byte_size, width, height, guest_name,
        upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at
      ) VALUES (
        'media-a', 'event-a', 'session-a', 'events/event-a/media/media-a',
        'photo.png', 'image/png', 8, 8, 1, 1, 'Guest', 'stored',
        'unpublished', 'legacy-a', '2026-08-12T00:10:00.000Z', ?, ?
      )
    `).bind(NOW, NOW).run();
    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename,
        mime_type, declared_byte_size, guest_name, upload_state,
        publication_status, idempotency_key, reservation_expires_at, created_at
      ) VALUES (
        'media-seeded-reserved', 'event-a', 'session-a',
        'events/event-a/media/media-seeded-reserved', 'reserved.png',
        'image/png', 8, 'Guest', 'reserved', 'unpublished',
        'seeded-reserved', '2026-08-12T00:10:00.000Z', ?
      )
    `).bind(NOW).run();
    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename,
        mime_type, declared_byte_size, guest_name, upload_state,
        publication_status, idempotency_key, reservation_expires_at, created_at,
        deleted_at
      ) VALUES (
        'media-seeded-deleted', 'event-a', 'session-a',
        'events/event-a/media/media-seeded-deleted', 'deleted.png',
        'image/png', 8, 'Guest', 'deleted', 'unpublished',
        'seeded-deleted', '2026-08-12T00:10:00.000Z', ?, ?
      )
    `).bind(NOW, NOW).run();

    await applyD1Migrations(env.DB, [migrationOnly('0015')]);

    expect(await env.DB.prepare(`
      SELECT media_id FROM media_object_promotions
      WHERE media_id IN ('media-seeded-reserved', 'media-seeded-deleted')
      ORDER BY media_id
    `).all()).toMatchObject({
      results: [
        { media_id: 'media-seeded-deleted' },
        { media_id: 'media-seeded-reserved' },
      ],
    });
    await expect(env.DB.prepare(`
      DELETE FROM media WHERE id = 'media-seeded-reserved'
    `).run()).rejects.toThrow();

    const seeded = await env.DB.prepare(`
      SELECT media_id, event_id, source_object_key, final_object_key,
             source_writable_until, state, claim_token
      FROM media_object_promotions WHERE media_id = 'media-a'
    `).first<Record<string, unknown>>();
    expect(seeded).toMatchObject({
      media_id: 'media-a',
      event_id: 'event-a',
      source_object_key: 'events/event-a/media/media-a',
      final_object_key: 'events/event-a/media/final/media-a',
      source_writable_until: '2026-08-12T00:10:00.000Z',
      state: 'pending',
      claim_token: null,
    });

    await env.DB.prepare(`
      UPDATE media_object_promotions
      SET state = 'copying', claim_token = 'owner-a',
          lease_expires_at = '2026-08-12T00:20:00.000Z'
      WHERE media_id = 'media-a'
    `).run();
    await env.DB.prepare(`
      UPDATE media SET object_key = object_key WHERE id = 'media-a'
    `).run();
    expect(await env.DB.prepare(`
      SELECT state, claim_token, lease_expires_at, source_object_key,
             final_object_key, source_writable_until
      FROM media_object_promotions WHERE media_id = 'media-a'
    `).first()).toMatchObject({
      state: 'copying',
      claim_token: 'owner-a',
      lease_expires_at: '2026-08-12T00:20:00.000Z',
      source_object_key: 'events/event-a/media/media-a',
      final_object_key: 'events/event-a/media/final/media-a',
      source_writable_until: '2026-08-12T00:10:00.000Z',
    });

    await expect(env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename,
        mime_type, declared_byte_size, byte_size, width, height, guest_name,
        upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at
      ) VALUES (
        'media-b', 'event-a', 'session-a', 'events/event-a/media/media-b',
        'photo-b.png', 'image/png', 8, 8, 1, 1, 'Guest', 'stored',
        'unpublished', 'legacy-b', '2026-08-12T00:10:00.000Z', ?, ?
      )
    `).bind(NOW, NOW).run()).rejects.toThrow(/legacy stored media creation is fenced/u);
    expect(await env.DB.prepare(`
      SELECT count(*) AS count FROM media_object_promotions WHERE media_id = 'media-b'
    `).first()).toEqual({ count: 0 });

    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename,
        mime_type, declared_byte_size, guest_name, upload_state,
        publication_status, idempotency_key, reservation_expires_at, created_at
      ) VALUES (
        'media-c', 'event-a', 'session-a', 'events/event-a/media/media-c',
        'photo-c.png', 'image/png', 8, 'Guest', 'reserved', 'unpublished',
        'legacy-c', '2026-08-12T00:10:00.000Z', ?
      )
    `).bind(NOW).run();
    expect(await env.DB.prepare(`
      SELECT state, source_writable_until
      FROM media_object_promotions WHERE media_id = 'media-c'
    `).first()).toMatchObject({
      state: 'pending', source_writable_until: '2026-08-12T00:10:00.000Z',
    });
    await env.DB.prepare(`
      UPDATE media SET reservation_expires_at = '2026-08-12T00:30:00.000Z'
      WHERE id = 'media-c'
    `).run();
    expect(await env.DB.prepare(`
      SELECT state, source_writable_until
      FROM media_object_promotions WHERE media_id = 'media-c'
    `).first()).toMatchObject({
      state: 'pending', source_writable_until: '2026-08-12T00:30:00.000Z',
    });

    const countersBeforeFencedUpdates = await env.DB.prepare(`
      SELECT reserved_media_count, reserved_bytes, stored_media_count, stored_bytes
      FROM events WHERE id = 'event-a'
    `).first();
    await env.DB.prepare(`
      UPDATE media_object_promotions
      SET state = 'copying', claim_token = 'owner-c',
          lease_expires_at = '2026-08-12T00:50:00.000Z'
      WHERE media_id = 'media-c'
    `).run();
    await expect(env.DB.prepare(`
      UPDATE media SET reservation_expires_at = '2026-08-12T00:40:00.000Z'
      WHERE id = 'media-c'
    `).run()).rejects.toThrow(/media reservation capability is fenced/u);
    await expect(env.DB.prepare(`
      UPDATE media
      SET byte_size = 8, width = 1, height = 1, upload_state = 'stored'
      WHERE id = 'media-c' AND upload_state = 'reserved'
    `).run()).rejects.toThrow(/legacy stored media creation is fenced/u);
    expect(await env.DB.prepare(`
      SELECT m.upload_state, m.byte_size, m.width, m.height,
             m.reservation_expires_at, p.state, p.claim_token,
             p.lease_expires_at, p.source_writable_until
      FROM media AS m
      JOIN media_object_promotions AS p ON p.media_id = m.id
      WHERE m.id = 'media-c'
    `).first()).toMatchObject({
      upload_state: 'reserved',
      byte_size: null,
      width: null,
      height: null,
      reservation_expires_at: '2026-08-12T00:30:00.000Z',
      state: 'copying',
      claim_token: 'owner-c',
      lease_expires_at: '2026-08-12T00:50:00.000Z',
      source_writable_until: '2026-08-12T00:30:00.000Z',
    });
    await env.DB.prepare(`
      UPDATE media_object_promotions
      SET state = 'pending', claim_token = NULL, lease_expires_at = NULL
      WHERE media_id = 'media-c'
    `).run();

    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename,
        mime_type, declared_byte_size, guest_name, upload_state,
        publication_status, idempotency_key, reservation_expires_at, created_at
      ) VALUES (
        'media-d', 'event-a', 'session-a', 'events/event-a/media/media-d',
        'photo-d.png', 'image/png', 8, 'Guest', 'reserved', 'unpublished',
        'legacy-d', '2026-08-12T00:10:00.000Z', ?
      )
    `).bind(NOW).run();
    await env.DB.prepare(`
      UPDATE media_object_promotions
      SET state = 'cleanup_pending', claim_token = 'owner-d'
      WHERE media_id = 'media-d'
    `).run();
    await expect(env.DB.prepare(`
      UPDATE media SET reservation_expires_at = '2026-08-12T00:20:00.000Z'
      WHERE id = 'media-d'
    `).run()).rejects.toThrow(/media reservation capability is fenced/u);
    await expect(env.DB.prepare(`
      UPDATE media
      SET byte_size = 8, width = 1, height = 1, upload_state = 'stored'
      WHERE id = 'media-d' AND upload_state = 'reserved'
    `).run()).rejects.toThrow(/legacy stored media creation is fenced/u);
    expect(await env.DB.prepare(`
      SELECT m.upload_state, m.byte_size, m.width, m.height,
             m.reservation_expires_at, p.state, p.claim_token,
             p.source_writable_until
      FROM media AS m
      JOIN media_object_promotions AS p ON p.media_id = m.id
      WHERE m.id = 'media-d'
    `).first()).toMatchObject({
      upload_state: 'reserved',
      byte_size: null,
      width: null,
      height: null,
      reservation_expires_at: '2026-08-12T00:10:00.000Z',
      state: 'cleanup_pending',
      claim_token: 'owner-d',
      source_writable_until: '2026-08-12T00:10:00.000Z',
    });

    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename,
        mime_type, declared_byte_size, guest_name, upload_state,
        publication_status, idempotency_key, reservation_expires_at, created_at
      ) VALUES (
        'media-e', 'event-a', 'session-a', 'events/event-a/media/media-e',
        'photo-e.png', 'image/png', 8, 'Guest', 'failed', 'unpublished',
        'legacy-e', '2026-08-12T00:10:00.000Z', ?
      )
    `).bind(NOW).run();
    expect(await env.DB.prepare(`
      SELECT count(*) AS count FROM media_object_promotions WHERE media_id = 'media-e'
    `).first()).toMatchObject({ count: 0 });
    await expect(env.DB.prepare(`
      UPDATE media
      SET upload_state = 'reserved', reservation_expires_at = '2026-08-12T00:20:00.000Z'
      WHERE id = 'media-e'
    `).run()).rejects.toThrow(/media reservation capability is fenced/u);
    expect(await env.DB.prepare(`
      SELECT upload_state, reservation_expires_at FROM media WHERE id = 'media-e'
    `).first()).toMatchObject({
      upload_state: 'failed', reservation_expires_at: '2026-08-12T00:10:00.000Z',
    });
    expect(await env.DB.prepare(`
      SELECT reserved_media_count, reserved_bytes, stored_media_count, stored_bytes
      FROM events WHERE id = 'event-a'
    `).first()).toEqual(countersBeforeFencedUpdates);

    await env.DB.prepare(`
      UPDATE media SET reservation_expires_at = '2026-08-12T00:20:00.000Z'
      WHERE id = 'media-c'
    `).run();
    await expect(env.DB.prepare(`
      UPDATE media
      SET upload_state = 'stored', byte_size = 8, width = 1, height = 1, stored_at = ?
      WHERE id = 'media-c'
    `).bind(NOW).run()).rejects.toThrow(/legacy stored media creation is fenced/u);
    expect(await env.DB.prepare(`
      SELECT upload_state, object_bucket_generation FROM media WHERE id = 'media-c'
    `).first()).toEqual({ upload_state: 'reserved', object_bucket_generation: 'legacy' });
    expect(await env.DB.prepare(`
      SELECT source_writable_until FROM media_object_promotions WHERE media_id = 'media-c'
    `).first()).toMatchObject({ source_writable_until: '2026-08-12T00:30:00.000Z' });

    await expect(env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size, width, height,
        guest_name, upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at
      ) VALUES (
        'media-illegal-stored', 'event-a', 'session-a',
        'events/event-a/media/media-illegal-stored', 'legacy', 'illegal.png',
        'image/png', 8, 8, 1, 1, 'Guest', 'stored', 'unpublished',
        'illegal-stored', '2026-08-12T00:30:00.000Z', ?, ?
      )
    `).bind(NOW, NOW).run()).rejects.toThrow(/legacy stored media creation is fenced/u);

    await expect(env.DB.prepare(`
      UPDATE media SET deleted_at = NULL, upload_state = 'stored'
      WHERE id = 'media-seeded-deleted'
    `).run()).rejects.toThrow(/legacy stored media creation is fenced/u);

    await env.DB.prepare(`
      UPDATE media_object_promotions
      SET state = 'target_verified', claim_token = 'verified-a', lease_expires_at = NULL,
          source_etag = 'legacy-etag-a', source_mime_type = 'image/png',
          source_byte_size = 8, source_sha256 = ?, source_width = 1, source_height = 1,
          final_etag = 'canonical-etag-a', target_verified_at = ?
      WHERE media_id = 'media-a'
    `).bind('a'.repeat(64), NOW).run();
    await expect(env.DB.prepare(`
      UPDATE media SET width = 2 WHERE id = 'media-a'
    `).run()).rejects.toThrow(/legacy stored media creation is fenced/u);
    expect(await env.DB.prepare(`
      SELECT p.state, p.source_width, m.width
      FROM media AS m JOIN media_object_promotions AS p ON p.media_id = m.id
      WHERE m.id = 'media-a'
    `).first()).toEqual({ state: 'target_verified', source_width: 1, width: 1 });
    await expect(env.DB.prepare(`
      UPDATE media_object_promotions SET source_sha256 = ? WHERE media_id = 'media-a'
    `).bind('b'.repeat(64)).run())
      .rejects.toThrow(/verified media target proof is immutable/u);
    await expect(env.DB.prepare(`
      DELETE FROM media_object_promotions WHERE media_id = 'media-a'
    `).run()).rejects.toThrow(/verified media target requires suppression handoff/u);

    await expect(env.DB.prepare(`
      UPDATE media SET caption = 'Moderation remains allowed' WHERE id = 'media-a'
    `).run()).resolves.toBeDefined();

    await expect(env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size, width, height,
        guest_name, upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at
      ) VALUES (
        'media-canonical-stored', 'event-a', 'session-a',
        'events/event-a/media/final/media-canonical-stored', 'canonical',
        'canonical.png', 'image/png', 8, 8, 1, 1, 'Guest', 'stored',
        'unpublished', 'canonical-stored', '2026-08-12T00:30:00.000Z', ?, ?
      )
    `).bind(NOW, NOW).run()).resolves.toBeDefined();

    // A pre-0015 preview Worker executes this generation-blind setter after
    // writing legacy preview bytes. Once the original pointer is canonical,
    // the schema itself must reject that old compiled Worker.
    await expect(env.DB.prepare(`
      UPDATE media SET preview_object_key = 'events/event-a/previews/media-canonical-stored.webp'
      WHERE id = 'media-canonical-stored'
    `).run()).rejects.toThrow(/permanently suppressed/u);
    expect(await env.DB.prepare(`
      SELECT preview_object_key FROM media WHERE id = 'media-canonical-stored'
    `).first()).toEqual({ preview_object_key: null });

    await expect(env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, object_bucket_generation,
        preview_object_key, original_filename, mime_type, declared_byte_size,
        byte_size, width, height, guest_name, upload_state, publication_status,
        idempotency_key, reservation_expires_at, created_at, stored_at
      ) VALUES (
        'media-canonical-preview', 'event-a', 'session-a',
        'events/event-a/media/final/media-canonical-preview', 'canonical',
        'events/event-a/previews/media-canonical-preview.webp',
        'canonical-preview.png', 'image/png', 8, 8, 1, 1, 'Guest', 'stored',
        'unpublished', 'canonical-preview', '2026-08-12T00:30:00.000Z', ?, ?
      )
    `).bind(NOW, NOW).run()).rejects.toThrow(/permanently suppressed/u);

    await expect(env.DB.prepare(`DELETE FROM media WHERE id = 'media-a'`).run()).rejects.toThrow();
    await expect(env.DB.prepare(`DELETE FROM events WHERE id = 'event-a'`).run()).rejects.toThrow();
  });

  it('keeps permanent non-FK discovery for every legacy write target across relational purge', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0015'));
    await seedEvent('event-tombstone');
    await env.DB.prepare(`
      INSERT INTO event_access_tokens (
        id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
      ) VALUES ('token-tombstone', 'event-tombstone', 'guest', 'secret', 'ciphertext', ?, ?)
    `).bind(NOW, NOW).run();
    await env.DB.prepare(`
      INSERT INTO event_sessions (
        id, secret_digest, event_id, access_token_id, role, csrf_digest,
        expires_at, created_at
      ) VALUES (
        'session-tombstone', 'session-secret', 'event-tombstone',
        'token-tombstone', 'guest', 'csrf', ?, ?
      )
    `).bind(NOW, NOW).run();
    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename,
        mime_type, declared_byte_size, byte_size, width, height, guest_name,
        upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at
      ) VALUES (
        'media-tombstone', 'event-tombstone', 'session-tombstone',
        'events/event-tombstone/uploads/media-tombstone', 'photo.png',
        'image/png', 8, 8, 1, 1, 'Guest', 'stored', 'unpublished',
        'tombstone', '2026-08-12T00:10:00.000Z', ?, ?
      )
    `).bind(NOW, NOW).run();

    await applyD1Migrations(env.DB, [migrationOnly('0015')]);

    expect(await env.DB.prepare(`
      SELECT object_key, object_kind, suppression_started_at,
             last_observed_at, last_observed_present
      FROM media_object_write_tombstones
      WHERE media_id = 'media-tombstone'
      ORDER BY object_kind
    `).all()).toMatchObject({
      results: [
        {
          object_key: 'events/event-tombstone/media/final/media-tombstone',
          object_kind: 'final', suppression_started_at: null,
          last_observed_at: null, last_observed_present: null,
        },
        {
          object_key: 'events/event-tombstone/previews/media-tombstone.webp',
          object_kind: 'preview', suppression_started_at: null,
          last_observed_at: null, last_observed_present: null,
        },
        {
          object_key: 'events/event-tombstone/uploads/media-tombstone',
          object_kind: 'source', suppression_started_at: null,
          last_observed_at: null, last_observed_present: null,
        },
      ],
    });
    expect((await env.DB.prepare(`
      PRAGMA foreign_key_list(media_object_write_tombstones)
    `).all()).results).toEqual([]);

    await env.DB.prepare(`DELETE FROM media_object_promotions WHERE media_id = 'media-tombstone'`).run();
    await env.DB.prepare(`DELETE FROM media WHERE id = 'media-tombstone'`).run();
    await env.DB.prepare(`DELETE FROM events WHERE id = 'event-tombstone'`).run();

    expect(await env.DB.prepare(`
      SELECT count(*) AS count FROM media_object_write_tombstones
      WHERE media_id = 'media-tombstone'
    `).first()).toMatchObject({ count: 3 });
  });

  it('inventories new and resurrected old-Worker aliases and blocks a suppressed alias becoming live', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0015'), migrationOnly('0015')]);
    await seedEvent('event-trigger');
    await env.DB.prepare(`
      INSERT INTO event_access_tokens (
        id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
      ) VALUES ('token-trigger', 'event-trigger', 'guest', 'secret', 'ciphertext', ?, ?)
    `).bind(NOW, NOW).run();
    await env.DB.prepare(`
      INSERT INTO event_sessions (
        id, secret_digest, event_id, access_token_id, role, csrf_digest,
        expires_at, created_at
      ) VALUES (
        'session-trigger', 'session-secret', 'event-trigger', 'token-trigger',
        'guest', 'csrf', ?, ?
      )
    `).bind(NOW, NOW).run();
    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename,
        mime_type, declared_byte_size, guest_name, upload_state,
        publication_status, idempotency_key, reservation_expires_at, created_at
      ) VALUES (
        'media-trigger', 'event-trigger', 'session-trigger',
        'events/event-trigger/uploads/media-trigger', 'photo.png', 'image/png',
        8, 'Guest', 'reserved', 'unpublished', 'trigger',
        '2026-08-12T00:10:00.000Z', ?
      )
    `).bind(NOW).run();

    expect(await env.DB.prepare(`
      SELECT object_kind FROM media_object_write_tombstones
      WHERE media_id = 'media-trigger' ORDER BY object_kind
    `).all()).toMatchObject({
      results: [{ object_kind: 'final' }, { object_kind: 'preview' }, { object_kind: 'source' }],
    });

    const resurrectedKey = 'events/event-trigger/uploads/media-trigger-retry';
    await env.DB.prepare(`
      UPDATE media SET object_key = ?, upload_state = 'failed' WHERE id = 'media-trigger'
    `).bind(resurrectedKey).run();
    expect(await env.DB.prepare(`
      SELECT object_kind FROM media_object_write_tombstones WHERE object_key = ?
    `).bind(resurrectedKey).first()).toMatchObject({ object_kind: 'source' });

    await env.DB.prepare(`
      UPDATE media_object_write_tombstones
      SET suppression_started_at = ?, next_check_at = ? WHERE object_key = ?
    `).bind(NOW, NOW, resurrectedKey).run();
    await expect(env.DB.prepare(`
      UPDATE media SET upload_state = 'reserved', deleted_at = NULL WHERE id = 'media-trigger'
    `).run()).rejects.toThrow();
    expect(await env.DB.prepare(`
      SELECT upload_state, object_key FROM media WHERE id = 'media-trigger'
    `).first()).toMatchObject({ upload_state: 'failed', object_key: resurrectedKey });
  });
});

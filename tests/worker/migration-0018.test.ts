import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ALBUM_DESCRIPTION_MAX_LENGTH,
  ALBUM_TITLE_MAX_LENGTH,
} from '../../shared/constants';
import { migrationOnly, migrationsUpTo } from './helpers';

const NOW = '2026-08-23T00:00:00.000Z';

async function seedEvent(id = 'event-a') {
  await env.DB.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
  `).bind(id, id, NOW, NOW, NOW, NOW).run();
}

async function seedExport(id: string, eventId = 'event-a') {
  await env.DB.prepare(`
    INSERT INTO export_jobs (
      id, event_id, state, snapshot_at, media_count, total_bytes, created_at
    ) VALUES (?, ?, 'failed', ?, 0, 0, ?)
  `).bind(id, eventId, NOW, NOW).run();
}

async function seedExportMedia(
  exportJobId: string,
  mediaId: string,
  albumTailPosition: number | null,
) {
  await env.DB.prepare(`
    INSERT INTO export_media_entries (
      export_job_id, media_id, object_key, object_bucket_generation,
      original_filename, mime_type, declared_byte_size, byte_size, width, height,
      guest_name, caption, publication_status, created_at, published_at,
      album_tail_position
    ) VALUES (?, ?, ?, 'canonical', ?, 'image/jpeg', 12, 12, 4, 3,
      'Avery Stone', NULL, 'unpublished', ?, NULL, ?)
  `).bind(
    exportJobId,
    mediaId,
    `events/event-a/media/final/${mediaId}`,
    `${mediaId}.jpg`,
    NOW,
    albumTailPosition,
  ).run();
}

describe('migration 0018 album end to end', () => {
  beforeEach(reset);

  it('backfills album metadata and preserves old export jobs as complete exports', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0018'));
    await seedEvent();
    await env.DB.prepare(`
      INSERT INTO event_albums (event_id, entries, saved_at, revision, created_at, updated_at)
      VALUES ('event-a', '[]', ?, 4, ?, ?)
    `).bind(NOW, NOW, NOW).run();
    await seedExport('export-old');

    await applyD1Migrations(env.DB, [migrationOnly('0018')]);

    expect(await env.DB.prepare(`
      SELECT title, description, cover_media_id FROM event_albums WHERE event_id = 'event-a'
    `).first()).toEqual({ title: 'Album', description: '', cover_media_id: null });
    expect(await env.DB.prepare(`
      SELECT kind, album_entries_json FROM export_jobs WHERE id = 'export-old'
    `).first()).toEqual({ kind: 'complete', album_entries_json: null });
  });

  it('enforces the album metadata limits at the database boundary', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0018'), migrationOnly('0018')]);
    await seedEvent();
    await env.DB.prepare(`
      INSERT INTO event_albums (event_id, entries, saved_at, revision, created_at, updated_at)
      VALUES ('event-a', '[]', NULL, 0, ?, ?)
    `).bind(NOW, NOW).run();

    await expect(env.DB.prepare(`UPDATE event_albums SET title = '   ' WHERE event_id = 'event-a'`).run())
      .rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE event_albums SET title = ? WHERE event_id = 'event-a'`)
      .bind('t'.repeat(ALBUM_TITLE_MAX_LENGTH + 1)).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE event_albums SET description = ? WHERE event_id = 'event-a'`)
      .bind('d'.repeat(ALBUM_DESCRIPTION_MAX_LENGTH + 1)).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE event_albums SET title = ?, description = ? WHERE event_id = 'event-a'
    `).bind(
      't'.repeat(ALBUM_TITLE_MAX_LENGTH),
      'd'.repeat(ALBUM_DESCRIPTION_MAX_LENGTH),
    ).run()).resolves.toBeDefined();
  });

  it('keeps one share per event and cascades share and event deletions', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0018'), migrationOnly('0018')]);
    await seedEvent();
    await env.DB.prepare(`
      INSERT INTO event_album_shares (
        id, event_id, secret_digest, secret_ciphertext, shared_at, created_at
      ) VALUES ('share-a', 'event-a', 'digest-a', 'cipher-a', ?, ?)
    `).bind(NOW, NOW).run();
    await expect(env.DB.prepare(`
      INSERT INTO event_album_shares (
        id, event_id, secret_digest, secret_ciphertext, shared_at, created_at
      ) VALUES ('share-b', 'event-a', 'digest-b', 'cipher-b', ?, ?)
    `).bind(NOW, NOW).run()).rejects.toThrow();
    await env.DB.prepare(`
      INSERT INTO event_album_share_sessions (
        id, share_id, event_id, secret_digest, expires_at, created_at
      ) VALUES ('session-a', 'share-a', 'event-a', 'session-digest', ?, ?)
    `).bind(NOW, NOW).run();

    await env.DB.prepare(`DELETE FROM event_album_shares WHERE id = 'share-a'`).run();

    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM event_album_share_sessions WHERE id = 'session-a'
    `).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM events WHERE id = 'event-a'
    `).first()).toEqual({ count: 1 });

    await env.DB.prepare(`
      INSERT INTO event_album_shares (
        id, event_id, secret_digest, secret_ciphertext, shared_at, created_at
      ) VALUES ('share-c', 'event-a', 'digest-c', 'cipher-c', ?, ?)
    `).bind(NOW, NOW).run();
    await env.DB.prepare(`
      INSERT INTO event_album_share_sessions (
        id, share_id, event_id, secret_digest, expires_at, created_at
      ) VALUES ('session-c', 'share-c', 'event-a', 'session-digest-c', ?, ?)
    `).bind(NOW, NOW).run();

    await env.DB.prepare(`DELETE FROM events WHERE id = 'event-a'`).run();

    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM event_album_shares`).first())
      .toEqual({ count: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM event_album_share_sessions`).first())
      .toEqual({ count: 0 });
  });

  it('indexes global expiry sweeps and per-share live-session admission', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0018'), migrationOnly('0018')]);

    const indexes = await env.DB.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'event_album_share_sessions'
        AND sql IS NOT NULL
      ORDER BY name
    `).all<{ name: string; sql: string }>();

    expect(indexes.results).toEqual([
      {
        name: 'event_album_share_sessions_expiry',
        sql: 'CREATE INDEX event_album_share_sessions_expiry\n'
          + '  ON event_album_share_sessions(expires_at, id)',
      },
      {
        name: 'event_album_share_sessions_share_expiry',
        sql: 'CREATE INDEX event_album_share_sessions_share_expiry\n'
          + '  ON event_album_share_sessions(share_id, expires_at, id)',
      },
    ]);
  });

  it('accepts only the matching complete or album export snapshot shape', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0018'), migrationOnly('0018')]);
    await seedEvent();

    await expect(env.DB.prepare(`
      INSERT INTO export_jobs (
        id, event_id, state, snapshot_at, media_count, total_bytes, created_at,
        kind, album_entries_json
      ) VALUES ('complete-with-album', 'event-a', 'failed', ?, 0, 0, ?, 'complete', '[]')
    `).bind(NOW, NOW).run()).rejects.toThrow();
    for (const invalidJson of [null, 'not-json', '{}']) {
      await expect(env.DB.prepare(`
        INSERT INTO export_jobs (
          id, event_id, state, snapshot_at, media_count, total_bytes, created_at,
          kind, album_entries_json
        ) VALUES (?, 'event-a', 'failed', ?, 0, 0, ?, 'album', ?)
      `).bind(`album-invalid-${String(invalidJson)}`, NOW, NOW, invalidJson).run()).rejects.toThrow();
    }
    await expect(env.DB.prepare(`
      INSERT INTO export_jobs (
        id, event_id, state, snapshot_at, media_count, total_bytes, created_at,
        kind, album_entries_json
      ) VALUES ('album-valid', 'event-a', 'failed', ?, 0, 0, ?, 'album', '[{"kind":"photo"}]')
    `).bind(NOW, NOW).run()).resolves.toBeDefined();
  });

  it('makes non-null album tail positions unique and 1-based within an export', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0018'), migrationOnly('0018')]);
    await seedEvent();
    await seedExport('export-a');
    await seedExportMedia('export-a', 'media-a', 1);
    await seedExportMedia('export-a', 'media-no-position', null);

    await expect(seedExportMedia('export-a', 'media-zero', 0)).rejects.toThrow();
    await expect(seedExportMedia('export-a', 'media-duplicate', 1)).rejects.toThrow();
    await expect(seedExportMedia('export-a', 'media-two', 2)).resolves.toBeUndefined();
  });
});

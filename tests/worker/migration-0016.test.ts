import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { migrationOnly, migrationsUpTo } from './helpers';

const NOW = '2026-08-13T00:00:00.000Z';
const SENTINEL = '1970-01-01T00:00:00.000Z';

async function seedEvent(id = 'event-a') {
  await env.DB.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
  `).bind(id, id, NOW, NOW, NOW, NOW).run();
}

async function seedSessionAndMedia() {
  await env.DB.prepare(`
    INSERT INTO event_access_tokens (
      id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
    ) VALUES ('token-a', 'event-a', 'guest', 'token-digest', 'ciphertext', ?, ?)
  `).bind(NOW, NOW).run();
  await env.DB.prepare(`
    INSERT INTO event_sessions (
      id, secret_digest, event_id, access_token_id, role, csrf_digest, expires_at, created_at
    ) VALUES ('session-a', 'session-digest', 'event-a', 'token-a', 'guest', 'csrf', ?, ?)
  `).bind(NOW, NOW).run();

  const mediaColumns = [
    'id', 'event_id', 'uploader_session_id', 'object_key', 'original_filename', 'mime_type',
    'declared_byte_size', 'byte_size', 'width', 'height', 'guest_name', 'caption', 'upload_state',
    'publication_status', 'idempotency_key', 'reservation_expires_at', 'created_at',
    'published_at', 'preview_object_key', 'deleted_at', 'stored_at', 'object_bucket_generation',
  ];
  const insert = (
    id: string,
    uploadState: string,
    storedAt: string | null,
    createdAt: string,
    generation: 'legacy' | 'canonical',
  ) => env.DB
    .prepare(`
      INSERT INTO media (${mediaColumns.join(', ')})
      VALUES (${mediaColumns.map(() => '?').join(', ')})
    `)
    .bind(
      id, 'event-a', 'session-a', `key-${id}`, `${id}.jpg`, 'image/jpeg',
      1024, 1024, 32, 32, 'Jose', 'Dance floor', uploadState,
      'unpublished', `idem-${id}`, NOW, createdAt,
      null, null, null, storedAt, generation,
    )
    .run();
  await insert('stored-a', 'stored', '2026-07-21T12:00:00.000Z', '2026-07-21T12:00:00.000Z', 'canonical');
  await insert('stored-b', 'stored', null, '2026-07-20T10:00:00.000Z', 'canonical');
  await insert('reserved-a', 'reserved', null, '2026-07-22T08:00:00.000Z', 'legacy');
}

describe('migration 0016 host private gallery', () => {
  beforeEach(reset);

  it('orders after 0015 and adds the three media columns with a constant sentinel default', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0016'), migrationOnly('0016')]);

    const columns = await env.DB.prepare('PRAGMA table_info(media)')
      .all<{ name: string; notnull: number; dflt_value: string | null }>();
    const byName = new Map(columns.results.map((column) => [column.name, column]));

    expect(byName.get('captured_at')?.notnull).toBe(0);
    expect(byName.get('favorited_at')?.notnull).toBe(0);
    expect(byName.get('timeline_at')?.notnull).toBe(1);
    expect(byName.get('timeline_at')?.dflt_value).toBe(`'${SENTINEL}'`);
  });

  it('backfills a populated 0015 database and stamps reserved rows transiently', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0016'));
    await seedEvent();
    await seedSessionAndMedia();

    await applyD1Migrations(env.DB, [migrationOnly('0016')]);

    const rows = await env.DB.prepare(`
      SELECT id, captured_at, timeline_at, favorited_at
      FROM media ORDER BY id
    `).all<{ id: string; captured_at: string | null; timeline_at: string; favorited_at: string | null }>();

    expect(rows.results).toEqual([
      {
        id: 'reserved-a',
        captured_at: null,
        timeline_at: '2026-07-22T08:00:00.000Z',
        favorited_at: null,
      },
      {
        id: 'stored-a',
        captured_at: null,
        timeline_at: '2026-07-21T12:00:00.000Z',
        favorited_at: null,
      },
      {
        id: 'stored-b',
        captured_at: null,
        timeline_at: '2026-07-20T10:00:00.000Z',
        favorited_at: null,
      },
    ]);

    const sentinels = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM media WHERE timeline_at = ?
    `).bind(SENTINEL).first<{ count: number }>();
    expect(sentinels?.count).toBe(0);
  });

  it('gives rows inserted by an older Worker the sentinel until a transition names timeline_at', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0016'), migrationOnly('0016')]);
    await seedEvent();
    await seedSessionAndMedia();

    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename, mime_type,
        declared_byte_size, guest_name, upload_state, publication_status,
        idempotency_key, reservation_expires_at, created_at
      ) VALUES (
        'mixed-window', 'event-a', 'session-a', 'key-mixed-window', 'mixed.jpg', 'image/jpeg',
        1024, 'Guest', 'reserved', 'unpublished', 'idem-mixed-window', ?, ?
      )
    `).bind(NOW, NOW).run();

    const row = await env.DB.prepare(`
      SELECT timeline_at, captured_at, favorited_at FROM media WHERE id = 'mixed-window'
    `).first<{ timeline_at: string; captured_at: string | null; favorited_at: string | null }>();
    expect(row).toEqual({ timeline_at: SENTINEL, captured_at: null, favorited_at: null });
  });

  it('installs the two event-scoped partial chronological indexes', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0016'), migrationOnly('0016')]);

    const indexes = await env.DB.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'media_private_gallery_timeline', 'media_private_gallery_favorites'
      ) ORDER BY name
    `).all<{ name: string; sql: string }>();

    expect(indexes.results.map(({ name }) => name)).toEqual([
      'media_private_gallery_favorites',
      'media_private_gallery_timeline',
    ]);
    expect(indexes.results[0]?.sql).toContain("upload_state = 'stored'");
    expect(indexes.results[0]?.sql).toContain('deleted_at IS NULL');
    expect(indexes.results[0]?.sql).toContain('favorited_at IS NOT NULL');
    expect(indexes.results[0]?.sql).toContain('event_id, timeline_at, id');
    expect(indexes.results[1]?.sql).toContain("upload_state = 'stored'");
    expect(indexes.results[1]?.sql).toContain('deleted_at IS NULL');
    expect(indexes.results[1]?.sql).toContain('event_id, timeline_at, id');
  });
});

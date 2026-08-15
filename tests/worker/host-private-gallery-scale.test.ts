import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_EVENT_THEME_CONFIG, serializeEventThemeConfig } from '../../shared/event-theme';
import { EventsRepository } from '../../worker/db/events';
import { MediaRepository } from '../../worker/db/media';
import type { AppEnv } from '../../worker/env';
import { batchD1Statements } from './helpers';

const testEnv = env as AppEnv & { TEST_MIGRATION_QUERIES: string };
const EVENT_START = '2026-09-19T00:00:00.000Z';

function mediaId(index: number, group = 0) {
  return `${String(group).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function seedEvent(id = 'event-a', slug = 'maya-theo') {
  const events = new EventsRepository(env.DB);
  await events.create({
    id,
    slug,
    name: 'Maya & Theo',
    eventDate: '2026-09-19',
    welcomeMessage: 'Welcome.',
    guestAccessExpiresAt: '2026-10-19T23:59:59.999Z',
    managementAccessExpiresAt: '2026-12-18T23:59:59.999Z',
    purgeAfter: '2027-01-17T23:59:59.999Z',
    createdAt: EVENT_START,
    themeConfig: serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG),
    eventTimezone: 'America/Chicago',
    rsvpDeadlineAt: '2026-09-13T04:59:59.999Z',
    eventStartAt: '2026-09-19T05:00:00.000Z',
  });
  await env.DB.prepare('UPDATE events SET photos_open_from = ? WHERE id = ?')
    .bind(EVENT_START, id).run();
  return events;
}

async function seedSession(eventId: string, suffix: string) {
  await env.DB.prepare(`
    INSERT INTO event_access_tokens (
      id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
    ) VALUES (?, ?, 'guest', ?, ?, ?, ?)
  `).bind(
    `token-${suffix}`, eventId, `digest-${suffix}`, `cipher-${suffix}`,
    '2026-10-19T23:59:59.999Z', EVENT_START,
  ).run();
  await env.DB.prepare(`
    INSERT INTO event_sessions (
      id, secret_digest, event_id, access_token_id, role, csrf_digest, expires_at, created_at
    ) VALUES (?, ?, ?, ?, 'guest', ?, ?, ?)
  `).bind(
    `session-${suffix}`, `session-digest-${suffix}`, eventId,
    `token-${suffix}`, `csrf-${suffix}`, '2026-10-19T23:59:59.999Z', EVENT_START,
  ).run();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, [{
    name: '0001_core.sql',
    queries: JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[],
  }]);
});

describe('host private gallery at the 10,000-photo event limit', () => {
  it('uses the partial indexes and stays event-local across all four query forms', async () => {
    await seedEvent('event-a');
    await seedEvent('event-b', 'other-event');
    await seedSession('event-a', 'a');
    await seedSession('event-b', 'b');

    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      const timelineAt = new Date(
        Date.parse(EVENT_START) + (index % 86_400) * 1000,
      ).toISOString();
      statements.push(env.DB.prepare(`
        INSERT INTO media (
          id, event_id, uploader_session_id, object_key, object_bucket_generation,
          original_filename, mime_type, declared_byte_size, byte_size, width, height,
          guest_name, caption, upload_state, publication_status, idempotency_key,
          reservation_expires_at, created_at, stored_at, captured_at, timeline_at,
          favorited_at
        ) VALUES (?, 'event-a', 'session-a', ?, 'canonical', ?, 'image/jpeg',
          1024, 1024, 800, 600, ?, NULL, 'stored', 'unpublished', ?, ?, ?, ?,
          NULL, ?, ?)
      `).bind(
        mediaId(index),
        `events/event-a/media/final/${mediaId(index)}`,
        `scale-${index}.jpg`,
        index < 10 ? 'Jose' : 'Other Guest',
        `scale-idem-${index}`,
        EVENT_START,
        EVENT_START,
        timelineAt,
        timelineAt,
        index % 100 === 0 ? EVENT_START : null,
      ));
    }
    for (let index = 0; index < 500; index += 1) {
      const timelineAt = new Date(Date.parse(EVENT_START) + index * 60_000).toISOString();
      statements.push(env.DB.prepare(`
        INSERT INTO media (
          id, event_id, uploader_session_id, object_key, object_bucket_generation,
          original_filename, mime_type, declared_byte_size, byte_size, width, height,
          guest_name, caption, upload_state, publication_status, idempotency_key,
          reservation_expires_at, created_at, stored_at, captured_at, timeline_at,
          favorited_at
        ) VALUES (?, 'event-b', 'session-b', ?, 'canonical', ?, 'image/jpeg',
          1024, 1024, 800, 600, 'Jose', NULL, 'stored', 'unpublished', ?, ?, ?, ?,
          NULL, ?, NULL)
      `).bind(
        mediaId(index, 1),
        `events/event-b/media/final/${mediaId(index, 1)}`,
        `unrelated-${index}.jpg`,
        `unrelated-idem-${index}`,
        EVENT_START,
        EVENT_START,
        timelineAt,
        timelineAt,
      ));
    }
    await batchD1Statements(env.DB, statements);

    const plainPlan = await env.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM media
      WHERE event_id = ? AND upload_state = 'stored' AND deleted_at IS NULL
      ORDER BY timeline_at ASC, id ASC LIMIT 49
    `).bind('event-a').all<{ detail: string }>();
    expect(plainPlan.results.map((row) => row.detail).join('\n'))
      .toContain('media_private_gallery_timeline');

    const favoritesPlan = await env.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM media
      WHERE event_id = ? AND upload_state = 'stored' AND deleted_at IS NULL
        AND favorited_at IS NOT NULL
      ORDER BY timeline_at ASC, id ASC LIMIT 49
    `).bind('event-a').all<{ detail: string }>();
    expect(favoritesPlan.results.map((row) => row.detail).join('\n'))
      .toContain('media_private_gallery_favorites');

    const repository = new MediaRepository(env.DB);
    const ceilingMs = 5000;

    const plainStarted = Date.now();
    const plain = await repository.listGalleryTimeline('event-a', {});
    expect(plain.media).toHaveLength(48);
    expect(plain.nextCursor).not.toBeNull();
    expect(Date.now() - plainStarted).toBeLessThan(ceilingMs);

    const favoritesStarted = Date.now();
    const favorites = await repository.listGalleryTimeline('event-a', { favorites: true });
    expect(favorites.media).toHaveLength(48);
    expect(favorites.media.every((media) => media.isFavorite)).toBe(true);
    expect(Date.now() - favoritesStarted).toBeLessThan(ceilingMs);

    const searchStarted = Date.now();
    const search = await repository.listGalleryTimeline('event-a', { query: 'JOSE' });
    expect(search.media).toHaveLength(10);
    expect(search.media.every((media) => media.guestName === 'Jose')).toBe(true);
    expect(Date.now() - searchStarted).toBeLessThan(ceilingMs);

    const combinedStarted = Date.now();
    const combined = await repository.listGalleryTimeline('event-a', {
      query: 'JOSE',
      favorites: true,
    });
    expect(combined.media).toHaveLength(1);
    expect(combined.media.every((media) => media.guestName === 'Jose' && media.isFavorite))
      .toBe(true);
    expect(Date.now() - combinedStarted).toBeLessThan(ceilingMs);
  });
});

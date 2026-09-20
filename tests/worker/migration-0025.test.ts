import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_EVENT_THEME_CONFIG, serializeEventThemeConfig } from '../../shared/event-theme';
import { EventsRepository } from '../../worker/db/events';
import { migrationOnly, migrationsUpTo } from './helpers';

const CREATED = '2026-09-18T08:00:00.000Z';
const TRASHED = '2026-09-18T12:00:00.000Z';
const RESTORE_UNTIL = '2026-09-25T12:00:00.000Z';

async function seedEventAndSession(eventId: string) {
  await new EventsRepository(env.DB).create({
    id: eventId,
    slug: eventId,
    name: 'Maya & Theo',
    eventDate: '2026-09-19',
    welcomeMessage: 'Welcome.',
    guestAccessExpiresAt: '2026-10-19T23:59:59.999Z',
    managementAccessExpiresAt: '2026-12-18T23:59:59.999Z',
    purgeAfter: '2027-01-17T23:59:59.999Z',
    createdAt: CREATED,
    themeConfig: serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG),
    eventTimezone: 'America/Chicago',
    rsvpDeadlineAt: '2026-09-13T04:59:59.999Z',
    eventStartAt: '2026-09-19T05:00:00.000Z',
  });
  await env.DB.prepare(`
    INSERT INTO event_access_tokens (
      id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
    ) VALUES (?, ?, 'guest', ?, ?, ?, ?)
  `).bind(
    `token-${eventId}`, eventId, `digest-${eventId}`, `cipher-${eventId}`,
    '2026-10-19T23:59:59.999Z', CREATED,
  ).run();
  await env.DB.prepare(`
    INSERT INTO event_sessions (
      id, secret_digest, event_id, access_token_id, role, csrf_digest, expires_at, created_at
    ) VALUES (?, ?, ?, ?, 'guest', ?, ?, ?)
  `).bind(
    `session-${eventId}`, `session-digest-${eventId}`, eventId, `token-${eventId}`,
    `csrf-${eventId}`, '2026-10-19T23:59:59.999Z', CREATED,
  ).run();
}

async function insertMedia(input: {
  id: string;
  eventId?: string;
  state: 'reserved' | 'stored' | 'deleted';
  createdAt: string;
  storedAt: string | null;
  trashed?: boolean;
}) {
  const eventId = input.eventId ?? 'event-a';
  const deletedAt = input.trashed ? TRASHED : input.state === 'deleted' ? TRASHED : null;
  await env.DB.prepare(`
    INSERT INTO media (
      id, event_id, uploader_session_id, object_key, object_bucket_generation,
      original_filename, mime_type, declared_byte_size, byte_size, width, height,
      guest_name, caption, upload_state, publication_status, idempotency_key,
      reservation_expires_at, created_at, stored_at, captured_at, timeline_at,
      favorited_at, deleted_at, trashed_at, restore_until
    ) VALUES (?, ?, ?, ?, 'canonical', ?, 'image/jpeg', 10, ?, ?, ?,
      'Avery', NULL, ?, 'unpublished', ?, '2026-09-19T00:00:00.000Z', ?, ?,
      NULL, ?, NULL, ?, ?, ?)
  `).bind(
    input.id,
    eventId,
    `session-${eventId}`,
    `events/${eventId}/media/final/${input.id}`,
    `${input.id}.jpg`,
    input.state === 'reserved' ? null : 10,
    input.state === 'reserved' ? null : 1,
    input.state === 'reserved' ? null : 1,
    input.state,
    `idem-${input.id}`,
    input.createdAt,
    input.storedAt,
    input.storedAt ?? input.createdAt,
    deletedAt,
    input.trashed ? TRASHED : null,
    input.trashed ? RESTORE_UNTIL : null,
  ).run();
}

describe('migration 0025 Library delivery sequence', () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, migrationsUpTo('0025'));
  });

  it('backfills every prior delivery per event without changing recovery or capacity state', async () => {
    await seedEventAndSession('event-a');
    await seedEventAndSession('event-b');
    await insertMedia({
      id: 'active-late', state: 'stored', createdAt: '2026-09-18T08:00:00.000Z',
      storedAt: '2026-09-18T10:00:00.000Z',
    });
    await insertMedia({
      id: 'active-early', state: 'stored', createdAt: '2026-09-18T08:00:00.000Z',
      storedAt: '2026-09-18T09:00:00.000Z',
    });
    await insertMedia({
      id: 'recoverable', state: 'stored', createdAt: '2026-09-18T08:00:00.000Z',
      storedAt: '2026-09-18T11:00:00.000Z', trashed: true,
    });
    await insertMedia({
      id: 'permanently-deleted', state: 'deleted', createdAt: '2026-09-18T08:00:00.000Z',
      storedAt: '2026-09-18T12:00:00.000Z',
    });
    await insertMedia({
      id: 'reservation', state: 'reserved', createdAt: '2026-09-18T13:00:00.000Z',
      storedAt: null,
    });
    await insertMedia({
      id: 'other-event', eventId: 'event-b', state: 'stored',
      createdAt: '2026-09-18T08:00:00.000Z', storedAt: '2026-09-18T12:00:00.000Z',
    });
    await env.DB.prepare(`
      UPDATE events SET
        reserved_media_count = 1, stored_media_count = 2, recoverable_media_count = 1,
        reserved_bytes = 10, stored_bytes = 20, recoverable_bytes = 10
      WHERE id = 'event-a'
    `).run();

    const markersBefore = await env.DB.prepare(`
      SELECT deleted_at, trashed_at, restore_until FROM media WHERE id = 'recoverable'
    `).first();
    const capacityBefore = await env.DB.prepare(`
      SELECT reserved_media_count, stored_media_count, recoverable_media_count,
        reserved_bytes, stored_bytes, recoverable_bytes
      FROM events WHERE id = 'event-a'
    `).first();

    await applyD1Migrations(env.DB, [migrationOnly('0025')]);

    const rows = await env.DB.prepare(`
      SELECT id, delivery_sequence FROM media ORDER BY id
    `).all<{ id: string; delivery_sequence: number | null }>();
    expect(Object.fromEntries(rows.results.map((row) => [row.id, row.delivery_sequence])))
      .toEqual({
        'active-early': 1,
        'active-late': 2,
        'other-event': 1,
        'permanently-deleted': 4,
        recoverable: 3,
        reservation: null,
      });
    expect(await env.DB.prepare(`
      SELECT id, last_delivery_sequence FROM events ORDER BY id
    `).all()).toMatchObject({ results: [
      { id: 'event-a', last_delivery_sequence: 4 },
      { id: 'event-b', last_delivery_sequence: 1 },
    ] });
    expect(await env.DB.prepare(`
      SELECT deleted_at, trashed_at, restore_until FROM media WHERE id = 'recoverable'
    `).first()).toEqual(markersBefore);
    expect(await env.DB.prepare(`
      SELECT reserved_media_count, stored_media_count, recoverable_media_count,
        reserved_bytes, stored_bytes, recoverable_bytes
      FROM events WHERE id = 'event-a'
    `).first()).toEqual(capacityBefore);

    await insertMedia({
      id: 'next-delivery', state: 'stored', createdAt: '2026-09-18T07:00:00.000Z',
      storedAt: '2026-09-18T07:00:00.000Z',
    });
    expect(await env.DB.prepare(`
      SELECT delivery_sequence FROM media WHERE id = 'next-delivery'
    `).first('delivery_sequence')).toBe(5);
    expect(await env.DB.prepare(`
      SELECT last_delivery_sequence FROM events WHERE id = 'event-a'
    `).first('last_delivery_sequence')).toBe(5);
  });

  it('assigns a reserved row once on its first stored transition', async () => {
    await seedEventAndSession('event-a');
    await insertMedia({
      id: 'reservation', state: 'reserved', createdAt: CREATED, storedAt: null,
    });
    await applyD1Migrations(env.DB, [migrationOnly('0025')]);

    await env.DB.prepare(`
      UPDATE media SET upload_state = 'stored', stored_at = ?, byte_size = 10,
        width = 1, height = 1 WHERE id = 'reservation'
    `).bind('2026-09-18T14:00:00.000Z').run();
    await env.DB.prepare(`UPDATE media SET upload_state = 'stored' WHERE id = 'reservation'`).run();

    expect(await env.DB.prepare(`
      SELECT delivery_sequence FROM media WHERE id = 'reservation'
    `).first('delivery_sequence')).toBe(1);
    expect(await env.DB.prepare(`
      SELECT last_delivery_sequence FROM events WHERE id = 'event-a'
    `).first('last_delivery_sequence')).toBe(1);
  });
});

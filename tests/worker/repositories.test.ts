import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { EventsRepository } from '../../worker/db/events';
import { ExportsRepository } from '../../worker/db/exports';
import { buildManagerMediaQuery, MediaRepository } from '../../worker/db/media';
import { SessionsRepository } from '../../worker/db/sessions';
import { TokensRepository } from '../../worker/db/tokens';

const testEnv = env as Env & { TEST_MIGRATION_QUERIES: string };
const now = '2026-07-21T12:00:00.000Z';

async function seedEvent(id = 'event-a', slug = 'maya-theo') {
  const events = new EventsRepository(env.DB);
  await events.create({
    id,
    slug,
    name: 'Maya & Theo',
    eventDate: '2026-09-19',
    welcomeMessage: 'Add the moments only you noticed.',
    guestAccessExpiresAt: '2026-10-19T23:59:59.999Z',
    managementAccessExpiresAt: '2026-12-18T23:59:59.999Z',
    purgeAfter: '2027-01-17T23:59:59.999Z',
    createdAt: now,
  });
  return events;
}

async function seedGuestSession(eventId = 'event-a', suffix = 'a') {
  const tokens = new TokensRepository(env.DB);
  const sessions = new SessionsRepository(env.DB);
  await tokens.create({
    id: `token-${suffix}`,
    eventId,
    role: 'guest',
    secretDigest: `token-digest-${suffix}`,
    secretCiphertext: `ciphertext-${suffix}`,
    expiresAt: '2026-10-19T23:59:59.999Z',
    createdAt: now,
  });
  await sessions.create({
    id: `session-${suffix}`,
    secretDigest: `session-digest-${suffix}`,
    csrfDigest: `csrf-${suffix}`,
    eventId,
    accessTokenId: `token-${suffix}`,
    role: 'guest',
    expiresAt: '2026-07-28T12:00:00.000Z',
    createdAt: now,
  });
  return `session-${suffix}`;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, [{
    name: '0001_core.sql',
    queries: JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[],
  }]);
});

describe('event, token, and session repositories', () => {
  it('creates and resolves event-scoped records without crossing events', async () => {
    const events = await seedEvent();
    await seedEvent('event-b', 'other-event');
    await seedGuestSession();

    expect((await events.getBySlug('maya-theo'))?.id).toBe('event-a');
    expect((await new SessionsRepository(env.DB).getForEvent('session-a', 'event-a'))?.role).toBe('guest');
    expect(await new SessionsRepository(env.DB).getForEvent('session-a', 'event-b')).toBeNull();
  });

  it('creates new events with the optional gallery hidden', async () => {
    const events = await seedEvent();

    expect((await events.getById('event-a'))?.galleryVisible).toBe(false);
  });
});

describe('media reservation and lifecycle', () => {
  it('requires a named guest for every new photo', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();

    await expect(new MediaRepository(env.DB).reserve({
      id: 'media-nameless', eventId: 'event-a', uploaderSessionId: sessionId,
      objectKey: 'events/event-a/media/nameless', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 1024, guestName: null as never, caption: null,
      idempotencyKey: 'idem-nameless', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('uses wedding-scale count and storage quotas', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    await env.DB.prepare(`
      UPDATE events SET stored_media_count = 50, stored_bytes = ? WHERE id = ?
    `).bind(300 * 1024 * 1024, 'event-a').run();

    const reserved = await new MediaRepository(env.DB).reserve({
      id: 'media-scale', eventId: 'event-a', uploaderSessionId: sessionId,
      objectKey: 'events/event-a/media/scale', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 1024, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-scale', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });

    expect(reserved.id).toBe('media-scale');
  });

  it('reserves quota once for an idempotency key', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const input = {
      id: 'media-a', eventId: 'event-a', uploaderSessionId: sessionId,
      objectKey: 'events/event-a/media/media-a', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg' as const, declaredByteSize: 1024,
      guestName: 'Avery', caption: null, idempotencyKey: 'idem-a',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    };

    const created = await media.reserve(input);
    const repeated = await media.reserve({ ...input, id: 'different-id', objectKey: 'different-key' });
    const event = await events.getById('event-a');

    expect(created.id).toBe('media-a');
    expect(repeated.id).toBe('media-a');
    expect(event?.reservedMediaCount).toBe(1);
    expect(event?.reservedBytes).toBe(1024);
  });

  it('reopens a failed idempotent reservation without duplicating quota', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const input = {
      id: 'media-retry', eventId: 'event-a', uploaderSessionId: sessionId,
      objectKey: 'events/event-a/media/media-retry', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg' as const, declaredByteSize: 1024,
      guestName: 'Avery', caption: null, idempotencyKey: 'idem-retry',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    };

    await media.reserve(input);
    await media.failReservation(input.id);
    const retried = await media.reserve({
      ...input,
      id: 'must-not-create-a-second-row',
      objectKey: 'must-not-create-a-second-object',
      reservationExpiresAt: '2026-07-21T12:45:00.000Z',
      createdAt: '2026-07-21T12:30:00.000Z',
    });
    const event = await events.getById('event-a');

    expect(retried).toMatchObject({
      id: 'media-retry', uploadState: 'reserved', reservationExpiresAt: '2026-07-21T12:45:00.000Z',
    });
    expect(event?.reservedMediaCount).toBe(1);
    expect(event?.reservedBytes).toBe(1024);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media').first<{ count: number }>())?.count).toBe(1);
  });

  it('refreshes an expired active reservation without reserving quota twice', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const input = {
      id: 'media-refresh', eventId: 'event-a', uploaderSessionId: sessionId,
      objectKey: 'events/event-a/media/media-refresh', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg' as const, declaredByteSize: 1024,
      guestName: 'Avery', caption: null, idempotencyKey: 'idem-refresh',
      reservationExpiresAt: '2026-07-21T12:05:00.000Z', createdAt: now,
    };

    await media.reserve(input);
    const refreshed = await media.reserve({
      ...input,
      id: 'ignored-id',
      reservationExpiresAt: '2026-07-21T12:45:00.000Z',
      createdAt: '2026-07-21T12:30:00.000Z',
    });
    const event = await events.getById('event-a');

    expect(refreshed).toMatchObject({ id: 'media-refresh', reservationExpiresAt: '2026-07-21T12:45:00.000Z' });
    expect(event?.reservedMediaCount).toBe(1);
    expect(event?.reservedBytes).toBe(1024);
  });

  it('reserves a new metadata batch through one aggregate repository operation', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const makeInput = (suffix: string, bytes: number) => ({
      id: `media-batch-${suffix}`, eventId: 'event-a', uploaderSessionId: sessionId,
      objectKey: `events/event-a/media/media-batch-${suffix}`, originalFilename: `${suffix}.jpg`,
      mimeType: 'image/jpeg' as const, declaredByteSize: bytes,
      guestName: 'Avery', caption: null, idempotencyKey: `idem-batch-${suffix}`,
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });

    const results = await media.reserveBatch([makeInput('a', 100), makeInput('b', 200), makeInput('c', 300)]);
    const event = await events.getById('event-a');

    expect(results.map((result) => result.status)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(results.map((result) => result.status === 'accepted' ? result.media.id : null))
      .toEqual(['media-batch-a', 'media-batch-b', 'media-batch-c']);
    expect(event).toMatchObject({ reservedMediaCount: 3, reservedBytes: 600 });
  });

  it('rejects count and byte quota overflow without leaving a row', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    await env.DB.prepare('UPDATE events SET stored_media_count = 10000 WHERE id = ?').bind('event-a').run();
    const media = new MediaRepository(env.DB);

    await expect(media.reserve({
      id: 'media-over', eventId: 'event-a', uploaderSessionId: sessionId,
      objectKey: 'events/event-a/media/over', originalFilename: 'over.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 1024, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-over', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    })).rejects.toMatchObject({ code: 'EVENT_MEDIA_LIMIT' });

    expect(await media.getById('media-over')).toBeNull();
  });

  it('finalizes once, enforces matching metadata, moderates, and deletes counters once', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    await media.reserve({
      id: 'media-a', eventId: 'event-a', uploaderSessionId: sessionId,
      objectKey: 'events/event-a/media/media-a', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 2048, guestName: 'Avery', caption: 'A quiet moment',
      idempotencyKey: 'idem-a', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });

    const finalized = await media.finalize('media-a', { byteSize: 1800, width: 1200, height: 800 });
    const repeated = await media.finalize('media-a', { byteSize: 1800, width: 1200, height: 800 });
    await expect(media.finalize('media-a', { byteSize: 1700, width: 1200, height: 800 }))
      .rejects.toMatchObject({ code: 'UPLOAD_FINALIZE_CONFLICT' });
    const approved = await media.setPublication('media-a', 'unpublished', 'published', '2026-07-21T12:05:00.000Z');
    await expect(media.setPublication('media-a', 'unpublished', 'hidden', now))
      .rejects.toMatchObject({ code: 'MEDIA_STATE_CONFLICT' });
    await media.delete('media-a', '2026-07-21T12:06:00.000Z');
    await media.delete('media-a', '2026-07-21T12:07:00.000Z');
    const event = await events.getById('event-a');

    expect(finalized.uploadState).toBe('stored');
    expect(repeated.byteSize).toBe(1800);
    expect(approved.publishedAt).toBe('2026-07-21T12:05:00.000Z');
    expect(event?.storedMediaCount).toBe(0);
    expect(event?.storedBytes).toBe(0);
  });

  it('keeps private delivery separate from optional publication and exports every stored original', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    await repository.reserve({
      id: 'media-private', eventId: 'event-a', uploaderSessionId: sessionId,
      objectKey: 'events/event-a/media/private', originalFilename: 'private.heic',
      mimeType: 'image/heic' as never, declaredByteSize: 2048, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-private', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });

    const delivered = await repository.finalize('media-private', { byteSize: 1800, width: 1200, height: 800 });
    const snapshot = await repository.exportSnapshot('event-a', '2026-07-21T12:30:00.000Z');

    expect((delivered as unknown as { publicationStatus: string }).publicationStatus).toBe('unpublished');
    expect(snapshot.map(({ id }) => id)).toEqual(['media-private']);
  });
});

describe('manager media pagination', () => {
  async function seedStored(count: number, eventId = 'event-a') {
    const sessionId = await seedGuestSession(eventId);
    for (const index of Array.from({ length: count }, (_, offset) => offset)) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const createdAt = new Date(Date.UTC(2026, 6, 20, 9, 0, 0) + index * 60_000).toISOString();
      await env.DB.prepare(`
        INSERT INTO media (
          id, event_id, uploader_session_id, object_key, original_filename, mime_type,
          declared_byte_size, byte_size, width, height, guest_name, caption, upload_state,
          publication_status, idempotency_key, reservation_expires_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, 'image/png', 128, 128, 800, 600, 'Avery', NULL, 'stored', 'unpublished', ?, ?, ?)
      `).bind(id, eventId, sessionId, `events/${eventId}/media/${id}`, `${index}.png`, `idem-${index}`, createdAt, createdAt).run();
    }
  }

  async function planFor(options: Parameters<typeof buildManagerMediaQuery>[1]) {
    const query = buildManagerMediaQuery('event-a', options);
    const explained = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...query.bindings)
      .all<{ detail: string }>();
    return explained.results.map((row) => row.detail).join(' | ');
  }

  it('plans both manager pages through the dedicated partial indexes without sorting', async () => {
    await seedEvent();
    await seedStored(3);
    const cursor = { createdAt: '2026-07-20T09:02:00.000Z', id: '00000000-0000-4000-8000-000000000002' };

    const unfiltered = await planFor({ limit: 24 });
    const unfilteredWithCursor = await planFor({ limit: 24, cursor });
    const filtered = await planFor({ limit: 24, status: 'published' });
    const filteredWithCursor = await planFor({ limit: 24, status: 'published', cursor });

    expect(unfiltered).toContain('media_manager_page_all');
    expect(unfilteredWithCursor).toContain('media_manager_page_all');
    expect(filtered).toContain('media_manager_page_status');
    expect(filteredWithCursor).toContain('media_manager_page_status');
    for (const plan of [unfiltered, unfilteredWithCursor, filtered, filteredWithCursor]) {
      expect(plan).not.toContain('TEMP B-TREE');
      expect(plan).not.toContain('SCAN media');
    }
  });

  it('closes the cursor on a last page that is exactly full', async () => {
    await seedEvent();
    await seedStored(48);
    const repository = new MediaRepository(env.DB);

    const first = await repository.listForManager('event-a', { limit: 24 });
    expect(first.media).toHaveLength(24);
    expect(first.nextCursor).not.toBeNull();

    const second = await repository.listForManager('event-a', { limit: 24, cursor: first.nextCursor! });
    expect(second.media).toHaveLength(24);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.media, ...second.media].map(({ id }) => id)).size).toBe(48);
  });
});

describe('export jobs', () => {
  it('permits only one queued or running export per event', async () => {
    await seedEvent();
    const exports = new ExportsRepository(env.DB);
    await exports.createActive({
      id: 'export-a', eventId: 'event-a', snapshotAt: now,
      mediaCount: 2, totalBytes: 4096, createdAt: now,
    });

    await expect(exports.createActive({
      id: 'export-b', eventId: 'event-a', snapshotAt: now,
      mediaCount: 2, totalBytes: 4096, createdAt: now,
    })).rejects.toMatchObject({ code: 'EXPORT_ALREADY_ACTIVE' });
  });
});

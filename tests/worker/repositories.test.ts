import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { EventsRepository } from '../../worker/db/events';
import { ExportsRepository } from '../../worker/db/exports';
import { MediaRepository } from '../../worker/db/media';
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
});

describe('media reservation and lifecycle', () => {
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

  it('rejects count and byte quota overflow without leaving a row', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    await env.DB.prepare('UPDATE events SET stored_media_count = 50 WHERE id = ?').bind('event-a').run();
    const media = new MediaRepository(env.DB);

    await expect(media.reserve({
      id: 'media-over', eventId: 'event-a', uploaderSessionId: sessionId,
      objectKey: 'events/event-a/media/over', originalFilename: 'over.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 1024, guestName: null, caption: null,
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

    const finalized = await media.finalize('media-a', { byteSize: 1800, width: 1200, height: 800 }, true);
    const repeated = await media.finalize('media-a', { byteSize: 1800, width: 1200, height: 800 }, true);
    await expect(media.finalize('media-a', { byteSize: 1700, width: 1200, height: 800 }, true))
      .rejects.toMatchObject({ code: 'UPLOAD_FINALIZE_CONFLICT' });
    const approved = await media.moderate('media-a', 'pending', 'approved', '2026-07-21T12:05:00.000Z');
    await expect(media.moderate('media-a', 'pending', 'rejected', now))
      .rejects.toMatchObject({ code: 'MEDIA_STATE_CONFLICT' });
    await media.delete('media-a', '2026-07-21T12:06:00.000Z');
    await media.delete('media-a', '2026-07-21T12:07:00.000Z');
    const event = await events.getById('event-a');

    expect(finalized.uploadState).toBe('stored');
    expect(repeated.byteSize).toBe(1800);
    expect(approved.approvedAt).toBe('2026-07-21T12:05:00.000Z');
    expect(event?.storedMediaCount).toBe(0);
    expect(event?.storedBytes).toBe(0);
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

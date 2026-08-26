import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_EVENT_THEME_CONFIG, serializeEventThemeConfig } from '../../shared/event-theme';
import { AlbumRepository } from '../../worker/db/album';
import { EventsRepository } from '../../worker/db/events';
import { MediaRepository } from '../../worker/db/media';
import type { AppEnv } from '../../worker/env';
import { finalizeStoredMedia, receiveMediaUpload } from '../../worker/storage/media';
import { png } from './helpers';
import { buildExifTiff, jpegWithExif } from './jpeg-exif';

const testEnv = env as AppEnv & { TEST_MIGRATION_QUERIES: string };

const EVENT_START = '2026-09-19T22:00:00.000Z';
const STORED_AT = '2026-09-19T22:50:00.000Z';
const TIMELINE_CONTEXT = {
  eventStartAt: EVENT_START,
  eventTimezone: 'America/Chicago',
};
const SENTINEL = '1970-01-01T00:00:00.000Z';
// Recovery is a real interval, not an instant: both ends of it stay inside the
// seeded event's management access and purge deadlines so the transitions under
// test are the only thing that can refuse.
const TRASHED_AT = '2026-09-20T00:00:00.000Z';
const RESTORED_AT = '2026-09-20T01:00:00.000Z';

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
    createdAt: EVENT_START,
    themeConfig: serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG),
    eventTimezone: 'America/Chicago',
    rsvpDeadlineAt: '2026-09-13T04:59:59.999Z',
    eventStartAt: EVENT_START,
  });
  await env.DB.prepare('UPDATE events SET photos_open_from = ? WHERE id = ?')
    .bind(EVENT_START, id).run();
  return events;
}

async function seedGuestSession(eventId = 'event-a', suffix = 'a') {
  await env.DB.prepare(`
    INSERT INTO event_access_tokens (
      id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
    ) VALUES (?, ?, 'guest', ?, ?, ?, ?)
  `).bind(
    `token-${suffix}`,
    eventId,
    `token-digest-${suffix}`,
    `ciphertext-${suffix}`,
    '2026-10-19T23:59:59.999Z',
    EVENT_START,
  ).run();
  await env.DB.prepare(`
    INSERT INTO event_sessions (
      id, secret_digest, event_id, access_token_id, role, csrf_digest, expires_at, created_at
    ) VALUES (?, ?, ?, ?, 'guest', ?, ?, ?)
  `).bind(
    `session-${suffix}`,
    `session-digest-${suffix}`,
    eventId,
    `token-${suffix}`,
    `csrf-${suffix}`,
    '2026-10-19T23:59:59.999Z',
    EVENT_START,
  ).run();
  return `session-${suffix}`;
}

function jpegCapture(capture: string): Uint8Array {
  return jpegWithExif(buildExifTiff([{ tag: 0x9003, value: capture }]));
}

async function reserveMedia(
  repository: MediaRepository,
  sessionId: string,
  id: string,
  bytes: Uint8Array,
  mimeType: 'image/jpeg' | 'image/png' = 'image/jpeg',
) {
  return repository.reserve({
    id,
    eventId: 'event-a',
    uploaderSessionId: sessionId,
    objectKey: `events/event-a/media/${id}`,
    originalFilename: `${id}.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
    mimeType,
    declaredByteSize: bytes.byteLength,
    guestName: 'Jose',
    caption: 'First dance',
    idempotencyKey: `idem-${id}`,
    reservationExpiresAt: '2026-09-19T23:00:00.000Z',
    createdAt: EVENT_START,
  });
}

async function insertStoredRow(row: {
  id: string;
  eventId: string;
  guestName?: string;
  caption?: string | null;
  filename?: string;
  timelineAt?: string;
  storedAt?: string | null;
  createdAt?: string;
  capturedAt?: string | null;
  favoritedAt?: string | null;
  deletedAt?: string | null;
}) {
  await env.DB.prepare(`
    INSERT INTO media (
      id, event_id, uploader_session_id, object_key, original_filename, mime_type,
      declared_byte_size, byte_size, width, height, guest_name, caption, upload_state,
      publication_status, idempotency_key, reservation_expires_at, created_at,
      published_at, preview_object_key, deleted_at, stored_at,
      object_bucket_generation, captured_at, timeline_at, favorited_at
    ) VALUES (?, ?, 'session-a', ?, ?, 'image/jpeg', 1024, 1024, 32, 32, ?, ?,
      ?, 'unpublished', ?, ?, ?, NULL, NULL, ?, ?, 'canonical', ?, ?, ?)
  `).bind(
    row.id,
    row.eventId,
    `key-${row.id}`,
    row.filename ?? `${row.id}.jpg`,
    row.guestName ?? 'Jose',
    row.caption ?? null,
    row.deletedAt === null || row.deletedAt === undefined ? 'stored' : 'deleted',
    `idem-${row.id}`,
    EVENT_START,
    row.createdAt ?? EVENT_START,
    row.deletedAt ?? null,
    row.storedAt === undefined ? STORED_AT : row.storedAt,
    row.capturedAt ?? null,
    row.timelineAt ?? STORED_AT,
    row.favoritedAt ?? null,
  ).run();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, [{
    name: '0001_core.sql',
    queries: JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[],
  }]);
});

describe('host private gallery storage timeline', () => {
  it('finalizeStoredMedia writes a trusted capture instant atomically with stored_at', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const bytes = jpegCapture('2026:09:19 17:42:30');
    const reserved = await reserveMedia(repository, sessionId, 'media-capture', bytes);
    await env.MEDIA_BUCKET.put(reserved.objectKey, bytes, {
      httpMetadata: { contentType: 'image/jpeg' },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(STORED_AT));
    let finalized;
    try {
      finalized = await finalizeStoredMedia(
        env.MEDIA_BUCKET,
        repository,
        reserved,
        TIMELINE_CONTEXT,
      );
    } finally {
      vi.useRealTimers();
    }

    expect(finalized).toMatchObject({
      uploadState: 'stored',
      storedAt: STORED_AT,
      capturedAt: '2026-09-19T22:42:30.000Z',
      timelineAt: '2026-09-19T22:42:30.000Z',
    });
    const row = await env.DB.prepare(`
      SELECT stored_at, captured_at, timeline_at FROM media WHERE id = ?
    `).bind(reserved.id).first();
    expect(row).toEqual({
      stored_at: STORED_AT,
      captured_at: '2026-09-19T22:42:30.000Z',
      timeline_at: '2026-09-19T22:42:30.000Z',
    });
  });

  it('finalizeStoredMedia falls back to received time for a PNG', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const bytes = png();
    const reserved = await reserveMedia(repository, sessionId, 'media-png', bytes, 'image/png');
    await env.MEDIA_BUCKET.put(reserved.objectKey, bytes, {
      httpMetadata: { contentType: 'image/png' },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(STORED_AT));
    let finalized;
    try {
      finalized = await finalizeStoredMedia(
        env.MEDIA_BUCKET,
        repository,
        reserved,
        TIMELINE_CONTEXT,
      );
    } finally {
      vi.useRealTimers();
    }

    expect(finalized).toMatchObject({
      uploadState: 'stored',
      storedAt: STORED_AT,
      capturedAt: null,
      timelineAt: STORED_AT,
    });
  });

  it('receiveMediaUpload writes the same values through the canonical ingress path', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const bytes = jpegCapture('2026:09:19 17:42:30');
    const reserved = await reserveMedia(repository, sessionId, 'media-ingress', bytes);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(STORED_AT));
    let stored;
    try {
      stored = await receiveMediaUpload(
        env.CANONICAL_MEDIA_BUCKET,
        repository,
        reserved,
        TIMELINE_CONTEXT,
        sessionId,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        'image/jpeg',
        new Date(STORED_AT),
      );
    } finally {
      vi.useRealTimers();
    }

    expect(stored).toMatchObject({
      uploadState: 'stored',
      storedAt: STORED_AT,
      capturedAt: '2026-09-19T22:42:30.000Z',
      timelineAt: '2026-09-19T22:42:30.000Z',
    });
    const row = await env.DB.prepare(`
      SELECT stored_at, captured_at, timeline_at FROM media WHERE id = ?
    `).bind(reserved.id).first();
    expect(row).toEqual({
      stored_at: STORED_AT,
      captured_at: '2026-09-19T22:42:30.000Z',
      timeline_at: '2026-09-19T22:42:30.000Z',
    });
  });
});

describe('host private gallery repository', () => {
  it('pages the timeline earliest-first with a deterministic id tie-break', async () => {
    await seedEvent();
    await seedGuestSession();
    await insertStoredRow({ id: 'g1', eventId: 'event-a', timelineAt: '2026-09-19T22:10:00.000Z' });
    await insertStoredRow({ id: 'g2', eventId: 'event-a', timelineAt: '2026-09-19T22:15:00.000Z' });
    await insertStoredRow({ id: 'g3', eventId: 'event-a', timelineAt: '2026-09-19T22:15:00.000Z' });

    const repository = new MediaRepository(env.DB);
    const first = await repository.listGalleryTimeline('event-a', { limit: 2, order: 'earliest' });
    expect(first.media.map((media) => media.id)).toEqual(['g1', 'g2']);
    expect(first.nextCursor).toEqual({ timelineAt: '2026-09-19T22:15:00.000Z', id: 'g2' });

    const second = await repository.listGalleryTimeline('event-a', {
      limit: 2,
      order: 'earliest',
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.media.map((media) => media.id)).toEqual(['g3']);
    expect(second.nextCursor).toBeNull();
  });

  it('pages newest-first by default, tie-breaking on id in the same direction', async () => {
    await seedEvent();
    await seedGuestSession();
    await insertStoredRow({ id: 'g1', eventId: 'event-a', timelineAt: '2026-09-19T22:10:00.000Z' });
    await insertStoredRow({ id: 'g2', eventId: 'event-a', timelineAt: '2026-09-19T22:15:00.000Z' });
    await insertStoredRow({ id: 'g3', eventId: 'event-a', timelineAt: '2026-09-19T22:15:00.000Z' });

    // The keyset comparison flips with the ordering, so the tie-break walks down the ids
    // here where earliest-first walks up them. If only one of the two flipped, the second
    // page would return a row the first page already gave back.
    const repository = new MediaRepository(env.DB);
    const first = await repository.listGalleryTimeline('event-a', { limit: 2 });
    expect(first.media.map((media) => media.id)).toEqual(['g3', 'g2']);
    expect(first.nextCursor).toEqual({ timelineAt: '2026-09-19T22:15:00.000Z', id: 'g2' });

    const second = await repository.listGalleryTimeline('event-a', {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.media.map((media) => media.id)).toEqual(['g1']);
    expect(second.nextCursor).toBeNull();
  });

  it('exposes received chronology for legacy rows without stored_at', async () => {
    await seedEvent();
    await seedGuestSession();
    await insertStoredRow({
      id: 'g1',
      eventId: 'event-a',
      storedAt: null,
      createdAt: '2026-09-19T20:00:00.000Z',
      timelineAt: '2026-09-19T20:00:00.000Z',
    });

    const page = await new MediaRepository(env.DB).listGalleryTimeline('event-a', {});
    expect(page.media[0]).toMatchObject({
      id: 'g1',
      receivedAt: '2026-09-19T20:00:00.000Z',
      timelineAt: '2026-09-19T20:00:00.000Z',
      timelineSource: 'received',
      isFavorite: false,
    });
  });

  it('matches search with ASCII-only folding and literal percent and underscore', async () => {
    await seedEvent();
    await seedEvent('event-b', 'other-event');
    await seedGuestSession();
    await insertStoredRow({ id: 'g1', eventId: 'event-a', guestName: 'Jose' });
    await insertStoredRow({ id: 'g2', eventId: 'event-a', guestName: 'josé' });
    await insertStoredRow({ id: 'g3', eventId: 'event-a', guestName: 'Guest', caption: 'Élan' });
    await insertStoredRow({
      id: 'g4',
      eventId: 'event-a',
      guestName: 'Guest',
      filename: '100%_final.jpg',
    });

    const repository = new MediaRepository(env.DB);
    expect((await repository.listGalleryTimeline('event-a', { query: 'JOSE' })).media
      .map((media) => media.id)).toEqual(['g1']);
    expect((await repository.listGalleryTimeline('event-a', { query: 'é' })).media
      .map((media) => media.id)).toEqual(['g2']);
    expect((await repository.listGalleryTimeline('event-a', { query: 'É' })).media
      .map((media) => media.id)).toEqual(['g3']);
    expect((await repository.listGalleryTimeline('event-a', { query: '100%_final' })).media
      .map((media) => media.id)).toEqual(['g4']);
    expect((await repository.listGalleryTimeline('event-b', { query: 'JOSE' })).media).toEqual([]);
  });

  it('filters to favorites and combines with search', async () => {
    await seedEvent();
    await seedGuestSession();
    await insertStoredRow({ id: 'g1', eventId: 'event-a', favoritedAt: '2026-09-19T23:00:00.000Z' });
    await insertStoredRow({ id: 'g2', eventId: 'event-a', guestName: 'Maya' });
    await insertStoredRow({
      id: 'g3',
      eventId: 'event-a',
      guestName: 'Maya',
      favoritedAt: '2026-09-19T23:00:00.000Z',
    });

    const repository = new MediaRepository(env.DB);
    expect((await repository.listGalleryTimeline('event-a', { favorites: true, order: 'earliest' }))
      .media.map((media) => media.id)).toEqual(['g1', 'g3']);
    expect((await repository.listGalleryTimeline('event-a', {
      favorites: true,
      order: 'earliest',
      query: 'maya',
    })).media.map((media) => media.id)).toEqual(['g3']);
    // The filters compose with either direction rather than pinning one.
    expect((await repository.listGalleryTimeline('event-a', { favorites: true }))
      .media.map((media) => media.id)).toEqual(['g3', 'g1']);
  });

  it('withholds a trashed photo from the timeline, search, and album picks until it is restored', async () => {
    await seedEvent();
    await seedGuestSession();
    await insertStoredRow({
      id: 'g1',
      eventId: 'event-a',
      guestName: 'Jose',
      timelineAt: '2026-09-19T22:10:00.000Z',
    });
    await insertStoredRow({
      id: 'g2',
      eventId: 'event-a',
      guestName: 'Maya',
      timelineAt: '2026-09-19T22:15:00.000Z',
    });
    // These rows are written straight into the table, so the event's capacity
    // counters have to be stated too. Trashing moves a photo's count and bytes
    // from the active bucket to the recoverable one, and neither may go below
    // zero on the way.
    await env.DB.prepare(`
      UPDATE events SET stored_media_count = 2, stored_bytes = 2048 WHERE id = 'event-a'
    `).run();

    const repository = new MediaRepository(env.DB);
    await repository.setFavorite('event-a', 'g1', '2026-09-19T23:00:00.000Z');
    await repository.setFavorite('event-a', 'g2', '2026-09-19T23:00:00.000Z');
    const albums = new AlbumRepository(env.DB);
    expect(await albums.get('event-a', TRASHED_AT)).toMatchObject({
      photoCount: 2,
      retainedCount: 0,
    });

    expect((await repository.trashStored('event-a', 'g1', TRASHED_AT)).trashedAt).toBe(TRASHED_AT);

    expect((await repository.listGalleryTimeline('event-a', { order: 'earliest' })).media
      .map((media) => media.id)).toEqual(['g2']);
    expect((await repository.listGalleryTimeline('event-a', { query: 'jose' })).media).toEqual([]);
    // The album loses the photograph and keeps the place it was standing in. A
    // slot that closed up would rearrange the album behind the host's back, and
    // then rearrange it again when they restored the photo.
    expect(await albums.get('event-a', TRASHED_AT)).toMatchObject({
      photoCount: 1,
      retainedCount: 1,
    });
    expect(await env.DB.prepare(`
      SELECT stored_media_count, stored_bytes, recoverable_media_count, recoverable_bytes
      FROM events WHERE id = 'event-a'
    `).first()).toEqual({
      stored_media_count: 1,
      stored_bytes: 1024,
      recoverable_media_count: 1,
      recoverable_bytes: 1024,
    });

    await repository.restoreTrashed('event-a', 'g1', RESTORED_AT);

    expect((await repository.listGalleryTimeline('event-a', { order: 'earliest' })).media
      .map((media) => media.id)).toEqual(['g1', 'g2']);
    expect((await repository.listGalleryTimeline('event-a', { query: 'jose' })).media
      .map((media) => media.id)).toEqual(['g1']);
    expect(await albums.get('event-a', RESTORED_AT)).toMatchObject({
      photoCount: 2,
      retainedCount: 0,
    });
    expect(await env.DB.prepare(`
      SELECT stored_media_count, stored_bytes, recoverable_media_count, recoverable_bytes
      FROM events WHERE id = 'event-a'
    `).first()).toEqual({
      stored_media_count: 2,
      stored_bytes: 2048,
      recoverable_media_count: 0,
      recoverable_bytes: 0,
    });
  });

  it('sets and clears a favorite idempotently and returns the gallery view', async () => {
    await seedEvent();
    await seedGuestSession();
    await insertStoredRow({ id: 'g1', eventId: 'event-a' });

    const repository = new MediaRepository(env.DB);
    const favoritedAt = '2026-09-19T23:00:00.000Z';
    const favorited = await repository.setFavorite('event-a', 'g1', favoritedAt);
    expect(favorited.favoritedAt).toBe(favoritedAt);
    const again = await repository.setFavorite('event-a', 'g1', '2026-09-19T23:05:00.000Z');
    expect(again.favoritedAt).toBe(favoritedAt);
    const cleared = await repository.setFavorite('event-a', 'g1', null);
    expect(cleared.favoritedAt).toBeNull();
    const refavorited = await repository.setFavorite('event-a', 'g1', '2026-09-19T23:10:00.000Z');
    expect(refavorited.favoritedAt).toBe('2026-09-19T23:10:00.000Z');
  });

  it('refuses a favorite write for foreign or removed media', async () => {
    await seedEvent();
    await seedEvent('event-b', 'other-event');
    await seedGuestSession();
    await insertStoredRow({ id: 'g1', eventId: 'event-a' });
    await insertStoredRow({
      id: 'g2',
      eventId: 'event-a',
      deletedAt: '2026-09-19T23:00:00.000Z',
    });

    const repository = new MediaRepository(env.DB);
    await expect(repository.setFavorite('event-b', 'g1', STORED_AT))
      .rejects.toMatchObject({ code: 'RESOURCE_FORBIDDEN' });
    await expect(repository.setFavorite('event-a', 'missing', STORED_AT))
      .rejects.toMatchObject({ code: 'RESOURCE_FORBIDDEN' });
    await expect(repository.setFavorite('event-a', 'g2', STORED_AT))
      .rejects.toMatchObject({ code: 'MEDIA_STATE_CONFLICT' });
  });

  it('counts and repairs only stored, non-deleted sentinel rows', async () => {
    await seedEvent();
    await seedGuestSession();
    await insertStoredRow({ id: 'g1', eventId: 'event-a', timelineAt: SENTINEL, storedAt: null });
    await insertStoredRow({
      id: 'g2',
      eventId: 'event-a',
      timelineAt: SENTINEL,
      storedAt: null,
      deletedAt: '2026-09-19T23:00:00.000Z',
    });
    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename, mime_type,
        declared_byte_size, guest_name, upload_state, publication_status,
        idempotency_key, reservation_expires_at, created_at, stored_at,
        object_bucket_generation, captured_at, timeline_at, favorited_at
      ) VALUES ('g3', 'event-a', 'session-a', 'key-g3', 'g3.jpg', 'image/jpeg', 1024,
        'Guest', 'reserved', 'unpublished', 'idem-g3', ?, ?, NULL, 'legacy', NULL, ?, NULL)
    `).bind(EVENT_START, EVENT_START, SENTINEL).run();

    const repository = new MediaRepository(env.DB);
    expect(await repository.countStoredTimelineSentinels('event-a')).toBe(1);
    expect(await repository.repairStoredTimelineSentinels(10, 'event-a')).toBe(1);
    expect(await repository.countStoredTimelineSentinels('event-a')).toBe(0);

    const repaired = await env.DB.prepare(`
      SELECT timeline_at FROM media WHERE id = 'g1'
    `).first<{ timeline_at: string }>();
    expect(repaired?.timeline_at).toBe(EVENT_START);
    const reserved = await env.DB.prepare(`
      SELECT timeline_at FROM media WHERE id = 'g3'
    `).first<{ timeline_at: string }>();
    expect(reserved?.timeline_at).toBe(SENTINEL);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import {
  MANAGER_MEDIA_MAX_PAGE_SIZE,
  MANAGER_MEDIA_PAGE_SIZE,
  MAX_EVENT_BYTES,
  MAX_EVENT_MEDIA,
  MEDIA_RECOVERY_WINDOW_MS,
} from '../../shared/constants';
import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { MediaRepository } from '../../worker/db/media';
import type { AppEnv } from '../../worker/env';
import {
  cleanupExpiredRecoverableMedia,
  deleteEventData,
  promoteLegacyStoredMedia,
} from '../../worker/workflows/cleanup';
import {
  applySettings,
  batchD1Statements,
  eventAccess,
  origin,
  png,
  resetDatabase,
  seedExportJob,
  testEnv,
  trashMedia,
  uploadPending,
  withRecordingImages,
  writeHeaders,
} from './helpers';

beforeEach(resetDatabase);

type Access = Awaited<ReturnType<typeof eventAccess>>;
type Media = Awaited<ReturnType<typeof uploadPending>>;

/**
 * The exact wire shapes. Compared as complete key sets rather than as a handful
 * of absent fields, because the interesting failure is a field nobody thought to
 * name: `ManagerTrashedMediaView` has no preview, no storage identity, and no
 * uploader session, and only an exhaustive comparison keeps it that way.
 */
const TRASHED_VIEW_KEYS = [
  'caption', 'guestName', 'id', 'originalFilename', 'restoreUntil', 'trashedAt',
].sort();
const MANAGER_VIEW_KEYS = [
  'caption', 'createdAt', 'guestName', 'height', 'id', 'originalFilename',
  'previewAvailable', 'publicationStatus', 'uploadState', 'width',
].sort();
const UPLOAD_VIEW_KEYS = ['id', 'mimeType', 'uploadState'].sort();

function managerPost(access: Access, path: string, body = '{}') {
  return createApp().request(`/api/manage/events/${access.event.id}${path}`, {
    method: 'POST',
    headers: writeHeaders(access.manager),
    body,
  }, testEnv);
}

function managerGet(access: Access, path: string, environment: AppEnv = testEnv) {
  return createApp().request(`/api/manage/events/${access.event.id}${path}`, {
    headers: { cookie: access.manager.cookie },
  }, environment);
}

function guestGet(access: Access, path: string, environment: AppEnv = testEnv) {
  return createApp().request(path, { headers: { cookie: access.guest.cookie } }, environment);
}

async function body(response: Response) {
  return await response.json<any>();
}

/** The four capacity numbers this slice moves between, read straight from D1. */
async function counters(eventId: string) {
  const row = await testEnv.DB.prepare(`
    SELECT stored_media_count, stored_bytes, recoverable_media_count, recoverable_bytes
    FROM events WHERE id = ?
  `).bind(eventId).first<{
    stored_media_count: number;
    stored_bytes: number;
    recoverable_media_count: number;
    recoverable_bytes: number;
  }>();
  if (!row) throw new Error('Expected the event to still exist.');
  return {
    storedCount: row.stored_media_count,
    storedBytes: row.stored_bytes,
    recoverableCount: row.recoverable_media_count,
    recoverableBytes: row.recoverable_bytes,
  };
}

async function mediaRow(mediaId: string) {
  return await testEnv.DB.prepare(`
    SELECT upload_state, deleted_at, trashed_at, restore_until FROM media WHERE id = ?
  `).bind(mediaId).first<{
    upload_state: string;
    deleted_at: string | null;
    trashed_at: string | null;
    restore_until: string | null;
  }>();
}

/** How many of a photo's object aliases some pass has claimed the right to delete. */
async function suppressedTombstones(mediaId: string) {
  return await testEnv.DB.prepare(`
    SELECT count(*) AS count FROM media_object_write_tombstones
    WHERE media_id = ? AND suppression_started_at IS NOT NULL
  `).bind(mediaId).first<number>('count');
}

/** The bucket the row's own generation says its bytes are in. */
function bucketFor(media: Media) {
  return media.objectBucketGeneration === 'canonical'
    ? testEnv.CANONICAL_MEDIA_BUCKET
    : testEnv.MEDIA_BUCKET;
}

function reserve(access: Access, key: string) {
  return createApp().request(`/api/event/${access.event.slug}/uploads`, {
    method: 'POST',
    headers: writeHeaders(access.guest),
    body: JSON.stringify({
      filename: `${key}.png`,
      mimeType: 'image/png',
      byteSize: png().byteLength,
      idempotencyKey: key,
      guestName: 'Avery',
      caption: null,
    }),
  }, testEnv);
}

function guestDelete(access: Access, mediaId: string) {
  return createApp().request(`/api/event/${access.event.slug}/uploads/${mediaId}`, {
    method: 'DELETE',
    headers: writeHeaders(access.guest),
  }, testEnv);
}

function trashListing(access: Access, query = '') {
  return managerGet(access, `/media/trash${query}`);
}

async function trashedIds(access: Access, query = '') {
  const response = await trashListing(access, query);
  expect(response.status).toBe(200);
  const payload = await body(response);
  return {
    ids: (payload.data.media as Array<{ id: string }>).map((item) => item.id),
    nextCursor: payload.data.nextCursor as string | null,
  };
}

describe('the Recently deleted Manager routes', () => {
  it('answers a first trash with the recovery projection and nothing a cache may keep', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'trash-shape', 'Under the oak', 'Avery Stone');

    const response = await managerPost(access, `/media/${media.id}/trash`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    const payload = await body(response);
    expect(Object.keys(payload.data)).toEqual(['media']);
    expect(Object.keys(payload.data.media).sort()).toEqual(TRASHED_VIEW_KEYS);
    expect(payload.data.media).toMatchObject({
      id: media.id,
      originalFilename: 'trash-shape.png',
      guestName: 'Avery Stone',
      caption: 'Under the oak',
    });
  });

  it('names no preview, object, storage, or session field in a retained photo', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'trash-leak', 'By the lake');
    // The deterministic preview alias every delivered photo owns, whether or not
    // a derivative was ever written to it.
    const previewKey = `events/${access.event.id}/previews/${media.id}.webp`;

    await trashMedia(access, media.id);
    const listing = await trashListing(access);
    const text = await listing.text();

    expect(text).not.toContain(media.objectKey);
    expect(text).not.toContain(previewKey);
    expect(text).not.toContain(media.uploaderSessionId);
    expect(text).not.toContain(media.objectBucketGeneration);
    expect(text).not.toContain('previewAvailable');
    expect(text).not.toContain('byteSize');
    expect(text).not.toContain('mimeType');
    expect(text).not.toContain('publicationStatus');
    expect(text).not.toContain('uploadState');
  });

  it('answers Restore with the ordinary Manager projection', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'restore-shape', 'Under the oak');
    await trashMedia(access, media.id);

    const response = await managerPost(access, `/media/${media.id}/restore`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    const payload = await body(response);
    expect(Object.keys(payload.data)).toEqual(['media']);
    expect(Object.keys(payload.data.media).sort()).toEqual(MANAGER_VIEW_KEYS);
    expect(payload.data.media).toMatchObject({ id: media.id, uploadState: 'stored' });
  });

  it('lists Recently deleted with a cursor field and the private cache headers', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'listing-shape', 'Under the oak');
    await trashMedia(access, media.id);

    const response = await trashListing(access);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    const payload = await body(response);
    expect(Object.keys(payload.data).sort()).toEqual(['media', 'nextCursor']);
    expect(payload.data.nextCursor).toBeNull();
    expect(payload.data.media).toHaveLength(1);
    expect(Object.keys(payload.data.media[0]).sort()).toEqual(TRASHED_VIEW_KEYS);
  });

  it('refuses any option sent to a transition whose only input is its path', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'strict-body', 'Under the oak');

    for (const sent of ['{"restoreUntil":"2099-01-01T00:00:00.000Z"}', '{"reason":"mistake"}', 'not-json']) {
      const refused = await managerPost(access, `/media/${media.id}/trash`, sent);
      expect(refused.status).toBe(422);
      expect((await body(refused)).code).toBe('VALIDATION_FAILED');
    }
    // An empty body and an absent body both mean the same thing, and both work.
    expect((await managerPost(access, `/media/${media.id}/trash`, '')).status).toBe(200);
    expect((await managerPost(access, `/media/${media.id}/restore`, '{"force":true}')).status).toBe(422);
    expect((await managerPost(access, `/media/${media.id}/restore`)).status).toBe(200);
  });

  it('answers a missing or foreign photo without confirming which it was', async () => {
    const access = await eventAccess();
    const other = await eventAccess('Rowan & Sky');
    const foreign = await uploadPending(other, 'foreign', null);
    const absent = crypto.randomUUID();

    for (const path of [`/media/${absent}/trash`, `/media/${foreign.id}/trash`]) {
      const refused = await managerPost(access, path);
      expect(refused.status).toBe(403);
      expect((await body(refused)).code).toBe('RESOURCE_FORBIDDEN');
    }
    for (const path of [`/media/${absent}/restore`, `/media/${foreign.id}/restore`]) {
      const refused = await managerPost(access, path);
      expect(refused.status).toBe(403);
      expect((await body(refused)).code).toBe('RESOURCE_FORBIDDEN');
    }
  });

  it('no longer accepts host deletion as a moderation action', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'patch-delete', null);

    const refused = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${media.id}`,
      {
        method: 'PATCH',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ action: 'delete', expectedStatus: 'unpublished' }),
      },
      testEnv,
    );

    expect(refused.status).toBe(422);
    expect((await body(refused)).code).toBe('VALIDATION_FAILED');
    expect((await mediaRow(media.id))?.upload_state).toBe('stored');
  });

  it('cancels a reservation permanently and sends a delivered photo to Recently deleted instead', async () => {
    const access = await eventAccess();
    const reserved = (await body(await reserve(access, 'cancel-me'))).data.media;
    const delivered = await uploadPending(access, 'not-cancellable', null);

    const cancelled = await managerPost(access, `/media/${reserved.id}/cancel-reservation`);
    expect(cancelled.status).toBe(200);
    const cancelledBody = await body(cancelled);
    expect(Object.keys(cancelledBody.data.media).sort()).toEqual(UPLOAD_VIEW_KEYS);
    expect(cancelledBody.data.media.uploadState).toBe('deleted');
    expect((await mediaRow(reserved.id))?.trashed_at).toBeNull();

    const refused = await managerPost(access, `/media/${delivered.id}/cancel-reservation`);
    expect(refused.status).toBe(409);
    expect((await body(refused)).code).toBe('MEDIA_STATE_CONFLICT');
    expect((await mediaRow(delivered.id))?.upload_state).toBe('stored');
  });
});

describe('the trash and restore transition matrix', () => {
  it('retains a delivered photo on the first trash and refuses the second with no counter delta', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'repeat-trash', null);

    await trashMedia(access, media.id);
    const afterFirst = await counters(access.event.id);

    const repeated = await managerPost(access, `/media/${media.id}/trash`);
    expect(repeated.status).toBe(409);
    expect((await body(repeated)).code).toBe('MEDIA_STATE_CONFLICT');
    expect(await counters(access.event.id)).toEqual(afterFirst);
    const row = await mediaRow(media.id);
    expect(row?.upload_state).toBe('stored');
    expect(row?.deleted_at).toBe(row?.trashed_at);
  });

  it('returns the committed trash projection when album materialization loses to a newer save', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'trash-materialization-race', null);
    await testEnv.DB.prepare(`UPDATE media SET favorited_at = ? WHERE id = ?`)
      .bind('2026-08-23T12:00:00.000Z', media.id).run();
    await testEnv.DB.prepare(`
      INSERT INTO event_albums (event_id, entries, saved_at, revision, created_at, updated_at)
      VALUES (?, '[]', ?, 0, ?, ?)
    `).bind(
      access.event.id,
      '2026-08-23T12:00:00.000Z',
      '2026-08-23T12:00:00.000Z',
      '2026-08-23T12:00:00.000Z',
    ).run();
    let newerSaveCommitted = false;
    const racingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!newerSaveCommitted) {
              newerSaveCommitted = true;
              await target.prepare(`
                UPDATE event_albums
                SET entries = ?, revision = revision + 1, updated_at = ?
                WHERE event_id = ?
              `).bind(
                JSON.stringify([{ kind: 'photo', mediaId: media.id }]),
                '2026-08-23T12:00:01.000Z',
                access.event.id,
              ).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const trashed = await new MediaRepository(racingDb).trashStored(
      access.event.id,
      media.id,
      '2026-08-23T12:00:02.000Z',
    );

    expect(trashed).toMatchObject({ id: media.id, trashedAt: '2026-08-23T12:00:02.000Z' });
    expect(await counters(access.event.id)).toEqual({
      storedCount: 0, storedBytes: 0, recoverableCount: 1, recoverableBytes: media.byteSize,
    });
  });

  it('recovers an exact committed trash when the D1 batch response is lost', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'trash-response-loss', null);
    const trashedAt = '2026-08-23T12:00:02.000Z';
    await testEnv.DB.prepare('UPDATE media SET favorited_at = ? WHERE id = ?')
      .bind('2026-08-23T12:00:00.000Z', media.id).run();
    await testEnv.DB.prepare(`
      INSERT INTO event_albums (event_id, entries, saved_at, revision, created_at, updated_at)
      VALUES (?, '[]', ?, 0, ?, ?)
    `).bind(
      access.event.id,
      '2026-08-23T12:00:00.000Z',
      '2026-08-23T12:00:00.000Z',
      '2026-08-23T12:00:00.000Z',
    ).run();
    let responseLost = false;
    const responseLosingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            if (!responseLost) {
              responseLost = true;
              throw new Error('simulated D1 response loss after commit');
            }
            return results;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repository = new MediaRepository(responseLosingDb);

    const trashed = await repository.trashStored(access.event.id, media.id, trashedAt);

    expect(responseLost).toBe(true);
    expect(trashed).toMatchObject({
      id: media.id,
      eventId: access.event.id,
      uploadState: 'stored',
      deletedAt: trashedAt,
      trashedAt,
      restoreUntil: expect.any(String),
    });
    expect(Date.parse(trashed.restoreUntil!)).toBeGreaterThan(Date.parse(trashedAt));
    expect(await counters(access.event.id)).toEqual({
      storedCount: 0, storedBytes: 0, recoverableCount: 1, recoverableBytes: media.byteSize,
    });
    expect(await testEnv.DB.prepare(`
      SELECT revision, entries FROM event_albums WHERE event_id = ?
    `).bind(access.event.id).first()).toMatchObject({
      revision: 1,
      entries: JSON.stringify([{ kind: 'photo', mediaId: media.id }]),
    });

    await expect(repository.trashStored(access.event.id, media.id, trashedAt))
      .rejects.toMatchObject({ code: 'MEDIA_STATE_CONFLICT', status: 409 });
    expect(await counters(access.event.id)).toEqual({
      storedCount: 0, storedBytes: 0, recoverableCount: 1, recoverableBytes: media.byteSize,
    });
  });

  it('rethrows a D1 batch error when no exact trash transition committed', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'trash-real-batch-error', null);
    const before = await counters(access.event.id);
    const batchError = new Error('simulated D1 rejection before commit');
    const rejectingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') return async () => { throw batchError; };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(new MediaRepository(rejectingDb).trashStored(
      access.event.id,
      media.id,
      '2026-08-23T12:00:02.000Z',
    )).rejects.toBe(batchError);
    expect(await mediaRow(media.id)).toMatchObject({
      upload_state: 'stored', deleted_at: null, trashed_at: null, restore_until: null,
    });
    expect(await counters(access.event.id)).toEqual(before);
  });

  it('restores a photo whose deadline has not passed and returns its capacity', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'restore-in-time', null);
    const active = await counters(access.event.id);

    await trashMedia(access, media.id);
    expect((await managerPost(access, `/media/${media.id}/restore`)).status).toBe(200);

    expect(await counters(access.event.id)).toEqual(active);
    const repeated = await managerPost(access, `/media/${media.id}/restore`);
    expect(repeated.status).toBe(409);
    expect((await body(repeated)).code).toBe('MEDIA_STATE_CONFLICT');
    expect(await counters(access.event.id)).toEqual(active);
    expect(await mediaRow(media.id)).toMatchObject({
      upload_state: 'stored',
      deleted_at: null,
      trashed_at: null,
      restore_until: null,
    });
  });

  it('refuses a restore at the deadline and after it, leaving the photo retained', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'restore-too-late', null);
    const repository = new MediaRepository(testEnv.DB);
    // Trashed in the past, so its own thirty-day window has already closed.
    const trashed = await repository.trashStored(access.event.id, media.id, '2026-01-05T00:00:00.000Z');
    const deadline = trashed.restoreUntil!;
    const retained = await counters(access.event.id);

    // `restore_until > now` is strict, so the deadline instant itself is over.
    await expect(repository.restoreTrashed(access.event.id, media.id, deadline))
      .rejects.toMatchObject({ code: 'MEDIA_STATE_CONFLICT', status: 409 });

    const later = await managerPost(access, `/media/${media.id}/restore`);
    expect(later.status).toBe(409);
    expect((await body(later)).code).toBe('MEDIA_STATE_CONFLICT');
    expect(await counters(access.event.id)).toEqual(retained);
    expect((await trashedIds(access)).ids).toEqual([media.id]);
  });

  it('lets a guest delete their own retained photo without double-counting either bucket', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'trash-then-guest', null);
    await trashMedia(access, media.id);
    expect(await counters(access.event.id)).toMatchObject({
      storedCount: 0, storedBytes: 0, recoverableCount: 1, recoverableBytes: media.byteSize,
    });

    const deleted = await guestDelete(access, media.id);

    expect(deleted.status).toBe(200);
    expect((await body(deleted)).data.media).toEqual({ id: media.id, deleted: true });
    expect(await counters(access.event.id)).toEqual({
      storedCount: 0, storedBytes: 0, recoverableCount: 0, recoverableBytes: 0,
    });
    const row = await mediaRow(media.id);
    expect(row?.upload_state).toBe('deleted');
    expect(row?.trashed_at).toBeNull();
    expect(row?.deleted_at).not.toBeNull();
    expect((await trashedIds(access)).ids).toEqual([]);
  });

  it('refuses the host trash when the guest deleted first, and moves no counter', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'guest-then-trash', null);

    expect((await guestDelete(access, media.id)).status).toBe(200);
    const afterGuest = await counters(access.event.id);

    const refused = await managerPost(access, `/media/${media.id}/trash`);
    expect(refused.status).toBe(409);
    expect((await body(refused)).code).toBe('MEDIA_STATE_CONFLICT');
    expect(await counters(access.event.id)).toEqual(afterGuest);
    expect(afterGuest).toEqual({
      storedCount: 0, storedBytes: 0, recoverableCount: 0, recoverableBytes: 0,
    });
  });

  it('refuses a Restore that lost to the guest deleting the same photo', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'restore-loses', null);
    await trashMedia(access, media.id);
    expect((await guestDelete(access, media.id)).status).toBe(200);
    const terminal = await counters(access.event.id);

    const refused = await managerPost(access, `/media/${media.id}/restore`);

    expect(refused.status).toBe(409);
    expect((await body(refused)).code).toBe('MEDIA_STATE_CONFLICT');
    expect(await counters(access.event.id)).toEqual(terminal);
    expect((await mediaRow(media.id))?.upload_state).toBe('deleted');
  });

  /**
   * The promotion fence and the recovery pair used to deadlock each other.
   *
   * `handoffPromotionToPermanentSuppression` asks "does the row still point
   * here", and it used to answer with `deleted_at IS NULL` — which a retained
   * photo fails, because its compatibility marker is set. The handoff then tried
   * to suppress the row's *current* canonical key, 0019's recoverable-owner guard
   * correctly aborted it, and the promotion sat in `cleanup_pending` forever. The
   * purge waits on exactly that fence, so an event with anything in Recently
   * deleted could never finish purging — at precisely the moment a retained row
   * is most likely to be there, since `restore_until` is clamped to `purge_after`.
   */
  it('settles the promotion inventory of a photo that is already retained', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'promotion-behind-retained', null);
    // Trash *first*. The promoter then has to settle an inventory row whose media
    // is retained rather than active, which is the ordering that used to stall.
    await trashMedia(access, media.id);

    await promoteLegacyStoredMedia(testEnv, new Date('2099-08-13T10:21:00.000Z'));

    expect(await testEnv.DB.prepare(
      'SELECT count(*) AS open FROM media_object_promotions WHERE media_id = ?',
    ).bind(media.id).first<{ open: number }>()).toEqual({ open: 0 });
    // Its current canonical key is still unsuppressed: a retained photo owns it.
    expect(await testEnv.DB.prepare(`
      SELECT suppression_started_at FROM media_object_write_tombstones
      WHERE media_id = ? AND object_kind = 'final'
    `).bind(media.id).first<{ suppression_started_at: string | null }>())
      .toEqual({ suppression_started_at: null });

    const purge = await deleteEventData(testEnv, access.event.id, new Date('2099-08-13T11:00:00.000Z'));
    expect(purge).toMatchObject({ phase: 'complete', remainder: false });
    expect(await mediaRow(media.id)).toBeNull();
    expect(await bucketFor(media).head(media.objectKey)).toBeNull();
  });

  it('ends recovery when the event is purged, before any object is swept', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'purged', null);
    // The upload's own promotion inventory is a separate fence the purge checks
    // first, and it has nothing to do with recovery. Settling it here keeps this
    // test about the phase that does: terminalizing a retained photo before the
    // event prefix is deleted.
    await promoteLegacyStoredMedia(testEnv, new Date('2099-08-13T10:21:00.000Z'));
    await trashMedia(access, media.id);
    expect(await bucketFor(media).head(media.objectKey)).not.toBeNull();

    const purge = await deleteEventData(testEnv, access.event.id, new Date('2099-08-13T11:00:00.000Z'));

    expect(purge).toMatchObject({ phase: 'complete', remainder: false });
    expect(await mediaRow(media.id)).toBeNull();
    expect(await bucketFor(media).head(media.objectKey)).toBeNull();
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
  });
});

describe('event capacity while a photo is retained', () => {
  it('moves exactly the photo bytes between the delivered and recoverable buckets', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'counter-transfer', null);
    const second = await uploadPending(access, 'counter-neighbour', null);
    expect(await counters(access.event.id)).toEqual({
      storedCount: 2,
      storedBytes: media.byteSize! + second.byteSize!,
      recoverableCount: 0,
      recoverableBytes: 0,
    });

    await trashMedia(access, media.id);
    expect(await counters(access.event.id)).toEqual({
      storedCount: 1,
      storedBytes: second.byteSize!,
      recoverableCount: 1,
      recoverableBytes: media.byteSize!,
    });

    expect((await managerPost(access, `/media/${media.id}/restore`)).status).toBe(200);
    expect(await counters(access.event.id)).toEqual({
      storedCount: 2,
      storedBytes: media.byteSize! + second.byteSize!,
      recoverableCount: 0,
      recoverableBytes: 0,
    });
  });

  it('shows the host both recovery counters and shows a guest neither', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'counter-projection', null);
    await trashMedia(access, media.id);

    const manager = (await body(await managerGet(access, ''))).data.event;
    expect(manager).toMatchObject({
      storedMediaCount: 0,
      storedBytes: 0,
      recoverableMediaCount: 1,
      recoverableBytes: media.byteSize,
    });

    const guest = (await body(await guestGet(access, `/api/event/${access.event.slug}`))).data.event;
    expect(Object.keys(guest)).not.toContain('recoverableMediaCount');
    expect(Object.keys(guest)).not.toContain('recoverableBytes');
    expect(Object.keys(guest)).not.toContain('storedMediaCount');
  });

  it('keeps the retained photo holding its slot against the photo cap', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'cap-count', null);
    // Every other photo this event may ever hold, so the delivered photo below
    // is the ten-thousandth and the event is exactly full.
    await testEnv.DB.prepare('UPDATE events SET stored_media_count = ? WHERE id = ?')
      .bind(MAX_EVENT_MEDIA, access.event.id).run();

    const beforeTrash = await reserve(access, 'cap-count-before');
    expect(beforeTrash.status).toBe(409);
    expect((await body(beforeTrash)).code).toBe('EVENT_MEDIA_LIMIT');

    await trashMedia(access, media.id);

    const afterTrash = await reserve(access, 'cap-count-after');
    expect(afterTrash.status).toBe(409);
    expect((await body(afterTrash)).code).toBe('EVENT_MEDIA_LIMIT');
    // The slot was never released, so it is still there to restore into.
    expect((await managerPost(access, `/media/${media.id}/restore`)).status).toBe(200);
    expect(await counters(access.event.id)).toMatchObject({
      storedCount: MAX_EVENT_MEDIA,
      recoverableCount: 0,
    });
  });

  it('keeps the retained photo holding its bytes against the storage cap', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'cap-bytes', null);
    await testEnv.DB.prepare('UPDATE events SET stored_bytes = ? WHERE id = ?')
      .bind(MAX_EVENT_BYTES, access.event.id).run();

    const beforeTrash = await reserve(access, 'cap-bytes-before');
    expect(beforeTrash.status).toBe(409);
    expect((await body(beforeTrash)).code).toBe('EVENT_STORAGE_LIMIT');

    await trashMedia(access, media.id);
    expect(await counters(access.event.id)).toMatchObject({
      storedBytes: MAX_EVENT_BYTES - media.byteSize!,
      recoverableBytes: media.byteSize!,
    });

    const afterTrash = await reserve(access, 'cap-bytes-after');
    expect(afterTrash.status).toBe(409);
    expect((await body(afterTrash)).code).toBe('EVENT_STORAGE_LIMIT');
    expect((await managerPost(access, `/media/${media.id}/restore`)).status).toBe(200);
    expect(await counters(access.event.id)).toMatchObject({
      storedBytes: MAX_EVENT_BYTES,
      recoverableBytes: 0,
    });
  });
});

describe('the recovery deadline', () => {
  it('lasts thirty days when nothing about the event is closer', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'deadline-window', null);

    const trashed = await trashMedia(access, media.id);

    expect(Date.parse(trashed.restoreUntil) - Date.parse(trashed.trashedAt))
      .toBe(MEDIA_RECOVERY_WINDOW_MS);
  });

  it('is clamped to the end of management access when that comes first', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'deadline-management', null);
    const managementEndsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    await testEnv.DB.prepare('UPDATE events SET management_access_expires_at = ? WHERE id = ?')
      .bind(managementEndsAt, access.event.id).run();

    const trashed = await trashMedia(access, media.id);

    expect(trashed.restoreUntil).toBe(managementEndsAt);
  });

  it('is clamped to the event purge time when that comes first', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'deadline-purge', null);
    const purgeAfter = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await testEnv.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind(purgeAfter, access.event.id).run();

    const trashed = await trashMedia(access, media.id);

    expect(trashed.restoreUntil).toBe(purgeAfter);
  });
});

/**
 * The named-query inventory.
 *
 * Every case reads the surface twice: once with the photo delivered, to prove the
 * fixture really would have listed it, and once after the trash. A test that only
 * checked the second half would pass against a surface that never showed the
 * photo in the first place.
 */
describe('where a retained photo may and may not appear', () => {
  async function inventoryFixture() {
    const access = await eventAccess();
    const visible = await applySettings(access, { galleryVisible: true });
    expect(visible.status).toBe(200);
    access.event = (await body(visible)).data.event;
    const retained = await uploadPending(access, 'inventory-retained', 'Under the oak', 'Avery Stone');
    const kept = await uploadPending(access, 'inventory-kept', 'By the lake', 'Jordan Lee');
    // Published and picked, so publication, album, Guestbook, and Gallery
    // surfaces all have a reason to carry both photographs.
    for (const id of [retained.id, kept.id]) {
      const published = await createApp().request(
        `/api/manage/events/${access.event.id}/media/${id}`,
        {
          method: 'PATCH',
          headers: writeHeaders(access.manager),
          body: JSON.stringify({ action: 'publish', expectedStatus: 'unpublished' }),
        },
        testEnv,
      );
      expect(published.status).toBe(200);
      const picked = await createApp().request(
        `/api/manage/events/${access.event.id}/media/${id}/favorite`,
        { method: 'PUT', headers: writeHeaders(access.manager), body: JSON.stringify({ favorite: true }) },
        testEnv,
      );
      expect(picked.status).toBe(200);
    }
    return { access, retained, kept };
  }

  it('leaves Manager Intake', async () => {
    const { access, retained, kept } = await inventoryFixture();
    const before = (await body(await managerGet(access, '/media'))).data.media as Array<{ id: string }>;
    expect(before.map((item) => item.id).sort()).toEqual([retained.id, kept.id].sort());

    await trashMedia(access, retained.id);

    const after = (await body(await managerGet(access, '/media'))).data.media as Array<{ id: string }>;
    expect(after.map((item) => item.id)).toEqual([kept.id]);
  });

  it('leaves the Library timeline and its search', async () => {
    const { access, retained, kept } = await inventoryFixture();
    const before = (await body(await managerGet(access, '/gallery'))).data.media as Array<{ id: string }>;
    expect(before.map((item) => item.id).sort()).toEqual([retained.id, kept.id].sort());
    const searchBefore = (await body(await managerGet(access, '/gallery?query=Avery'))).data.media;
    expect((searchBefore as Array<{ id: string }>).map((item) => item.id)).toEqual([retained.id]);

    await trashMedia(access, retained.id);

    const after = (await body(await managerGet(access, '/gallery'))).data.media as Array<{ id: string }>;
    expect(after.map((item) => item.id)).toEqual([kept.id]);
    expect((await body(await managerGet(access, '/gallery?query=Avery'))).data.media).toEqual([]);
  });

  it('becomes an opaque retained slot in the Manager album rather than a pick', async () => {
    const { access, retained, kept } = await inventoryFixture();
    const before = (await body(await managerGet(access, '/album'))).data.album;
    expect(before.photoCount).toBe(2);
    expect(before.retainedCount).toBe(0);

    const trashed = await trashMedia(access, retained.id);

    const after = (await body(await managerGet(access, '/album'))).data.album;
    expect(after.photoCount).toBe(1);
    expect(after.retainedCount).toBe(1);
    const slot = (after.entries as any[]).find((entry) => entry.kind === 'photo-retained');
    expect(slot.slot).toEqual({
      mediaId: retained.id,
      restoreUntil: trashed.restoreUntil,
      state: 'recoverable',
    });
    expect((after.entries as any[]).filter((entry) => entry.kind === 'photo')
      .map((entry) => entry.photo.id)).toEqual([kept.id]);
  });

  it('leaves the album link a recipient reads', async () => {
    const { access, retained, kept } = await inventoryFixture();
    // Sharing requires a saved album, so this is the arrangement the link serves.
    const saved = await createApp().request(`/api/manage/events/${access.event.id}/album`, {
      method: 'PUT',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({
        revision: 0,
        entries: [
          { kind: 'photo', mediaId: retained.id },
          { kind: 'photo', mediaId: kept.id },
        ],
      }),
    }, testEnv);
    expect(saved.status).toBe(200);
    const share = (await body(await createApp().request(
      `/api/manage/events/${access.event.id}/album/share`,
      { method: 'POST', headers: writeHeaders(access.manager) },
      testEnv,
    ))).data.share;
    const exchanged = await createApp().request('/api/album-share/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ token: new URL(share.url).hash.slice(1) }),
    }, testEnv);
    const albumCookie = `candidary_album=${/candidary_album=([^;,]+)/u.exec(
      exchanged.headers.get('set-cookie') ?? '',
    )![1]}`;
    const publicIds = async () => {
      const response = await createApp().request('/api/album-share', { headers: { cookie: albumCookie } }, testEnv);
      expect(response.status).toBe(200);
      const album = (await body(response)).data.album;
      return (album.entries as any[]).filter((entry) => entry.kind === 'photo')
        .map((entry) => entry.photo.id);
    };
    expect((await publicIds()).sort()).toEqual([retained.id, kept.id].sort());

    await trashMedia(access, retained.id);

    expect(await publicIds()).toEqual([kept.id]);
  });

  it('leaves the Manager album preview, in both its projection and its images', async () => {
    const { access, retained, kept } = await inventoryFixture();
    const images = withRecordingImages().env;
    const previewIds = async () => {
      const response = await managerGet(access, '/album/preview');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toBe('Cookie');
      expect(response.headers.get('set-cookie')).toBeNull();
      const album = (await body(response)).data.album;
      return (album.entries as any[]).filter((entry) => entry.kind === 'photo')
        .map((entry) => entry.photo.id);
    };
    expect((await previewIds()).sort()).toEqual([retained.id, kept.id].sort());
    expect((await managerGet(access, `/album/media/${retained.id}/preview`, images)).status).toBe(200);

    await trashMedia(access, retained.id);

    expect(await previewIds()).toEqual([kept.id]);
    const refused = await managerGet(access, `/album/media/${retained.id}/preview`, images);
    expect(refused.status).toBe(403);
    expect((await body(refused)).code).toBe('RESOURCE_FORBIDDEN');
  });

  it('leaves the guest gallery', async () => {
    const { access, retained, kept } = await inventoryFixture();
    const galleryIds = async () => {
      const response = await guestGet(access, `/api/event/${access.event.slug}/gallery`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return ((await body(response)).data.media as Array<{ id: string }>).map((item) => item.id);
    };
    expect((await galleryIds()).sort()).toEqual([retained.id, kept.id].sort());

    await trashMedia(access, retained.id);

    expect(await galleryIds()).toEqual([kept.id]);
  });

  it('leaves the contributing guest own list', async () => {
    const { access, retained, kept } = await inventoryFixture();
    const contributionIds = async () => {
      const response = await guestGet(access, `/api/event/${access.event.slug}/contributions`);
      expect(response.status).toBe(200);
      return ((await body(response)).data.media as Array<{ id: string }>).map((item) => item.id);
    };
    expect((await contributionIds()).sort()).toEqual([retained.id, kept.id].sort());

    await trashMedia(access, retained.id);

    expect(await contributionIds()).toEqual([kept.id]);
  });

  it('leaves the Guestbook caption feed', async () => {
    const { access, retained, kept } = await inventoryFixture();
    // Both captions are on published photos in a visible gallery, so `shared` is
    // the view that carries them.
    const captionIds = async () => {
      const response = await managerGet(access, '/guestbook?view=shared&source=photo_caption');
      expect(response.status).toBe(200);
      const payload = await body(response);
      return {
        ids: (payload.data.items as Array<{ mediaId: string | null }>).map((item) => item.mediaId),
        summary: payload.data.summary as Record<string, number>,
      };
    };
    const before = await captionIds();
    expect(before.ids.sort()).toEqual([retained.id, kept.id].sort());

    await trashMedia(access, retained.id);

    const after = await captionIds();
    expect(after.ids).toEqual([kept.id]);
    expect(after.summary.sharedCount).toBe(before.summary.sharedCount! - 1);
  });

  it('leaves preview and original delivery', async () => {
    const { access, retained } = await inventoryFixture();
    const images = withRecordingImages().env;
    expect((await createApp().request(`/api/media/${retained.id}/preview`, {
      headers: { cookie: access.manager.cookie },
    }, images)).status).toBe(200);
    expect((await createApp().request(`/api/media/${retained.id}/original`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv)).status).toBe(200);

    await trashMedia(access, retained.id);

    const preview = await createApp().request(`/api/media/${retained.id}/preview`, {
      headers: { cookie: access.manager.cookie },
    }, images);
    expect(preview.status).toBe(403);
    expect((await body(preview)).code).toBe('ROLE_FORBIDDEN');
    const original = await createApp().request(`/api/media/${retained.id}/original`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(original.status).toBe(403);
    expect((await body(original)).code).toBe('ROLE_FORBIDDEN');
  });

  it('leaves a newly created export snapshot', async () => {
    const { access, retained, kept } = await inventoryFixture();
    await trashMedia(access, retained.id);

    const created = await managerPost(access, '/exports');

    expect(created.status).toBe(202);
    const job = (await body(created)).data.export;
    expect(job.mediaCount).toBe(1);
    expect(job.totalBytes).toBe(kept.byteSize);
    const frozen = await testEnv.DB.prepare(
      'SELECT media_id FROM export_media_entries WHERE export_job_id = ?',
    ).bind(job.id).all<{ media_id: string }>();
    expect(frozen.results.map((row) => row.media_id)).toEqual([kept.id]);
  });

  it('leaves the delivered counts the host is shown', async () => {
    const { access, retained, kept } = await inventoryFixture();
    const before = (await body(await managerGet(access, ''))).data.event;
    expect(before.storedMediaCount).toBe(2);

    await trashMedia(access, retained.id);

    const after = (await body(await managerGet(access, ''))).data.event;
    expect(after.storedMediaCount).toBe(1);
    expect(after.storedBytes).toBe(kept.byteSize);
    expect(after.recoverableMediaCount).toBe(1);
  });

  it('appears in exactly one place, Recently deleted', async () => {
    const { access, retained, kept } = await inventoryFixture();

    await trashMedia(access, retained.id);

    const listed = await trashedIds(access);
    expect(listed.ids).toEqual([retained.id]);
    expect(listed.nextCursor).toBeNull();
    // And the delivered photo is not smuggled in the other direction.
    expect(listed.ids).not.toContain(kept.id);
  });
});

describe('Recently deleted pagination', () => {
  const SEED_EPOCH_MS = Date.UTC(2026, 6, 20, 9, 0, 0);

  function seedId(index: number) {
    return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  }

  /**
   * Insert delivered rows straight into D1 so ids and timestamps are chosen,
   * then move each one through the real transition. Indexes 2 and 3 deliberately
   * share a `trashed_at`, and in a twenty-seven row collection that tie lands
   * exactly on the default page boundary — so the second page is correct only if
   * the cursor's id tie-break decides it.
   */
  async function seedTrashed(access: Access, count: number) {
    const session = await testEnv.DB
      .prepare("SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1")
      .bind(access.event.id).first<{ id: string }>();
    if (!session) throw new Error('Expected a guest session for the seeded event.');

    const seeded: Array<{ id: string; trashedAt: string }> = [];
    for (let index = 0; index < count; index += 1) {
      const id = seedId(index);
      const createdAt = new Date(SEED_EPOCH_MS + index * 60_000).toISOString();
      await testEnv.DB.prepare(`
        INSERT INTO media (
          id, event_id, uploader_session_id, object_key, object_bucket_generation,
          original_filename, mime_type, declared_byte_size, byte_size, width, height,
          guest_name, caption, upload_state, publication_status, idempotency_key,
          reservation_expires_at, created_at, stored_at
        ) VALUES (?, ?, ?, ?, 'canonical', ?, 'image/png', 128, 128, 800, 600,
          'Avery Stone', NULL, 'stored', 'unpublished', ?, ?, ?, ?)
      `).bind(
        id, access.event.id, session.id, `events/${access.event.id}/media/final/${id}`,
        `seed-${index}.png`, `seed-${index}`, createdAt, createdAt, createdAt,
      ).run();
      seeded.push({
        id,
        trashedAt: new Date(SEED_EPOCH_MS + (index === 3 ? 2 : index) * 60_000).toISOString(),
      });
    }
    // The seeded rows are delivered originals, so the event's delivered counters
    // have to say so before the transition may move them into recovery.
    await testEnv.DB.prepare(`
      UPDATE events SET stored_media_count = stored_media_count + ?, stored_bytes = stored_bytes + ?
      WHERE id = ?
    `).bind(count, count * 128, access.event.id).run();

    const repository = new MediaRepository(testEnv.DB);
    for (const row of seeded) await repository.trashStored(access.event.id, row.id, row.trashedAt);
    return [...seeded].sort((left, right) => (
      right.trashedAt.localeCompare(left.trashedAt) || right.id.localeCompare(left.id)
    )).map((row) => row.id);
  }

  it('pages twenty-four at a time by default, newest deletion first', async () => {
    const access = await eventAccess();
    const expected = await seedTrashed(access, MANAGER_MEDIA_PAGE_SIZE + 3);

    const first = await trashedIds(access);

    expect(first.ids).toEqual(expected.slice(0, MANAGER_MEDIA_PAGE_SIZE));
    expect(first.nextCursor).not.toBeNull();
  });

  it('round-trips its cursor across the whole collection without repeating a photo', async () => {
    const access = await eventAccess();
    const expected = await seedTrashed(access, MANAGER_MEDIA_PAGE_SIZE + 3);

    const first = await trashedIds(access);
    const second = await trashedIds(access, `?cursor=${encodeURIComponent(first.nextCursor!)}`);

    expect(second.ids).toEqual(expected.slice(MANAGER_MEDIA_PAGE_SIZE));
    expect(second.nextCursor).toBeNull();
    expect([...first.ids, ...second.ids]).toEqual(expected);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(expected.length);
    // The two rows deleted at the same instant, split across the boundary in
    // descending id order rather than repeated or skipped.
    expect(first.ids.at(-1)).toBe(seedId(3));
    expect(second.ids[0]).toBe(seedId(2));
  });

  it('serves the maximum page and refuses one photo past it', async () => {
    const access = await eventAccess();
    const expected = await seedTrashed(access, MANAGER_MEDIA_PAGE_SIZE + 3);

    const largest = await trashedIds(access, `?limit=${MANAGER_MEDIA_MAX_PAGE_SIZE}`);
    expect(largest.ids).toEqual(expected);
    expect(largest.nextCursor).toBeNull();

    for (const limit of [String(MANAGER_MEDIA_MAX_PAGE_SIZE + 1), '0', '-1', 'all']) {
      const refused = await trashListing(access, `?limit=${limit}`);
      expect(refused.status).toBe(422);
      expect((await body(refused)).code).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses a cursor it did not issue', async () => {
    const access = await eventAccess();
    await seedTrashed(access, 2);
    const intakeCursor = (await body(await managerGet(access, '/media?limit=1'))).data.nextCursor;

    for (const cursor of ['not-base64', btoa('{"trashedAt":"nope","id":"nope"}'), intakeCursor]) {
      const refused = await trashListing(access, `?cursor=${encodeURIComponent(String(cursor))}`);
      expect(refused.status).toBe(422);
      expect((await body(refused)).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('scheduled recovery cleanup', () => {
  // Trashed long enough ago that its own thirty-day window closed well before
  // the sweep below runs.
  const TRASHED_AT = '2026-01-05T00:00:00.000Z';
  const SWEEP_AT = new Date('2026-03-01T00:00:00.000Z');

  async function expiredPhoto(access: Access, key: string) {
    const media = await uploadPending(access, key, null);
    await new MediaRepository(testEnv.DB).trashStored(access.event.id, media.id, TRASHED_AT);
    return media;
  }

  it('permanently deletes an expired retained photo and gives back its capacity', async () => {
    const access = await eventAccess();
    const media = await expiredPhoto(access, 'sweep-expired');
    expect(await counters(access.event.id)).toMatchObject({ recoverableCount: 1 });

    const summary = await cleanupExpiredRecoverableMedia(testEnv, SWEEP_AT);

    expect(summary).toEqual({ terminalized: 1, held: 0 });
    expect(await mediaRow(media.id)).toMatchObject({
      upload_state: 'deleted',
      deleted_at: SWEEP_AT.toISOString(),
      trashed_at: null,
      restore_until: null,
    });
    expect(await counters(access.event.id)).toEqual({
      storedCount: 0, storedBytes: 0, recoverableCount: 0, recoverableBytes: 0,
    });
    expect((await trashedIds(access)).ids).toEqual([]);
    // The recovery capacity is what this pass returns. Physical retirement of a
    // freshly delivered original is inventoried against its own promotion row and
    // belongs to the tombstone janitor, so no key is claimed here.
    expect(await suppressedTombstones(media.id)).toBe(0);
  });

  it('keeps an expired photo whose exact source an accepted export still holds', async () => {
    const access = await eventAccess();
    const media = await expiredPhoto(access, 'sweep-held');
    await seedExportJob({
      id: crypto.randomUUID(),
      eventId: access.event.id,
      snapshotAt: TRASHED_AT,
      state: 'queued',
      media: [media],
    });
    const retained = await counters(access.event.id);

    const summary = await cleanupExpiredRecoverableMedia(testEnv, SWEEP_AT);

    expect(summary).toEqual({ terminalized: 0, held: 1 });
    expect(await mediaRow(media.id)).toMatchObject({ upload_state: 'stored', restore_until: expect.any(String) });
    expect(await counters(access.event.id)).toEqual(retained);
    // Still listed, because the host can still see why it has not gone yet —
    // and still unrestorable, because the deadline itself did pass.
    expect((await trashedIds(access)).ids).toEqual([media.id]);
    const refused = await managerPost(access, `/media/${media.id}/restore`);
    expect(refused.status).toBe(409);
    // The bytes the export was promised are still there, and no pass has won the
    // right to take them.
    expect(await bucketFor(media).head(media.objectKey)).not.toBeNull();
    expect(await suppressedTombstones(media.id)).toBe(0);
  });

  it('deletes it on a later pass once that export is terminal', async () => {
    const access = await eventAccess();
    const media = await expiredPhoto(access, 'sweep-released');
    const jobId = crypto.randomUUID();
    await seedExportJob({
      id: jobId,
      eventId: access.event.id,
      snapshotAt: TRASHED_AT,
      state: 'queued',
      media: [media],
    });
    expect(await cleanupExpiredRecoverableMedia(testEnv, SWEEP_AT)).toEqual({ terminalized: 0, held: 1 });

    expect((await new ExportsRepository(testEnv.DB)
      .markInitialDispatchFailed(jobId, 'EXPORT_TEST_TERMINAL')).changed).toBe(true);
    const summary = await cleanupExpiredRecoverableMedia(
      testEnv,
      new Date('2026-03-02T00:00:00.000Z'),
    );

    expect(summary).toEqual({ terminalized: 1, held: 0 });
    expect((await mediaRow(media.id))?.upload_state).toBe('deleted');
    expect(await counters(access.event.id)).toMatchObject({ recoverableCount: 0, recoverableBytes: 0 });
    expect((await trashedIds(access)).ids).toEqual([]);
  });

  it('selects releasable expired work behind a held prefix larger than the cleanup bound', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(access.event.id).first<string>('id');
    if (!sessionId) throw new Error('Expected the event guest session.');
    const heldIds = Array.from({ length: 1001 }, (_, index) => `held-${String(index).padStart(4, '0')}`);
    const unheldId = 'unheld-after-prefix';
    const allIds = [...heldIds, unheldId];

    await batchD1Statements(testEnv.DB, allIds.map((id, index) => testEnv.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size, width, height,
        guest_name, upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at, timeline_at,
        deleted_at, trashed_at, restore_until
      ) VALUES (
        ?1, ?2, ?3, ?4, 'canonical', ?5, 'image/jpeg', 1, 1, 1, 1,
        'Avery', 'stored', 'unpublished', ?6, ?7, ?7, ?7, ?7, ?8, ?8, ?9
      )
    `).bind(
      id,
      access.event.id,
      sessionId,
      `events/${access.event.id}/media/final/${id}`,
      `${id}.jpg`,
      `idem-${id}`,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      index < heldIds.length ? '2026-01-02T00:00:00.000Z' : '2026-01-03T00:00:00.000Z',
    )));
    await testEnv.DB.prepare(`
      UPDATE events SET recoverable_media_count = ?, recoverable_bytes = ? WHERE id = ?
    `).bind(allIds.length, allIds.length, access.event.id).run();
    const jobId = 'held-prefix-job';
    await testEnv.DB.prepare(`
      INSERT INTO export_jobs (
        id, event_id, state, snapshot_at, media_count, total_bytes, attempt, created_at,
        guestbook_entry_count, guestbook_shared_count, execution_protocol
      ) VALUES (?, ?, 'queued', ?, ?, ?, 1, ?, 0, 0, 'attempt-v2')
    `).bind(
      jobId, access.event.id, '2026-01-01T00:00:00.000Z',
      heldIds.length, heldIds.length, '2026-01-01T00:00:00.000Z',
    ).run();
    await batchD1Statements(testEnv.DB, heldIds.map((id) => testEnv.DB.prepare(`
      INSERT INTO export_media_entries (
        export_job_id, media_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size, width, height,
        guest_name, caption, publication_status, created_at, published_at
      ) VALUES (?, ?, ?, 'canonical', ?, 'image/jpeg', 1, 1, 1, 1,
        'Avery', NULL, 'unpublished', ?, NULL)
    `).bind(
      jobId, id, `events/${access.event.id}/media/final/${id}`, `${id}.jpg`,
      '2026-01-01T00:00:00.000Z',
    )));

    const summary = await cleanupExpiredRecoverableMedia(testEnv, SWEEP_AT);

    // `held` is a bounded diagnostic sample; the pass never scans or reports an
    // unbounded held population merely to reach releasable work.
    expect(summary).toEqual({ terminalized: 1, held: 100 });
    expect((await mediaRow(unheldId))?.upload_state).toBe('deleted');
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM media
      WHERE event_id = ? AND id LIKE 'held-%' AND trashed_at IS NOT NULL
    `).bind(access.event.id).first<number>('count')).toBe(heldIds.length);
  });
});

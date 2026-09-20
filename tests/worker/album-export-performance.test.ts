import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../../worker/env';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { eventAccess, png, resetDatabase, testEnv, uploadPending } from './helpers';

const PHOTO_BYTES = 2_334_146;
const FRAGMENT_BYTES = 16 * 1024;

async function albumFixture(photoBytes = PHOTO_BYTES) {
  const access = await eventAccess();
  const photos = [];
  const bytes = png(800, 600, photoBytes);
  for (let index = 0; index < 2; index += 1) {
    const photo = await uploadPending(access, `album-performance-${index}`);
    await testEnv.CANONICAL_MEDIA_BUCKET.put(photo.objectKey, bytes);
    await testEnv.DB.prepare('UPDATE media SET byte_size=?, declared_byte_size=? WHERE id=?')
      .bind(photoBytes, photoBytes, photo.id).run();
    photos.push(photo);
  }
  const now = new Date(Date.now() + 1_000);
  await testEnv.DB.prepare('UPDATE media SET favorited_at=? WHERE event_id=?')
    .bind(now.toISOString(), access.event.id).run();
  await testEnv.DB.prepare('INSERT INTO event_albums (event_id,entries,saved_at,created_at,updated_at) VALUES (?,?,?,?,?)')
    .bind(access.event.id, JSON.stringify(photos.map(photo => ({ kind: 'photo', mediaId: photo.id }))),
      now.toISOString(), now.toISOString(), now.toISOString()).run();
  const repository = new ExportsRepository(testEnv.DB);
  const job = await repository.createAlbumActive({ id: crypto.randomUUID(), eventId: access.event.id,
    snapshotAt: now.toISOString(), createdAt: now.toISOString() });
  return { access, photos, bytes, now, job, repository };
}

// R2's transport fragmentation must not dictate the number of database trips.
function fragmentedBucket(bytes: Uint8Array, onPull: (offset: number) => Promise<void> = async () => {}) {
  const base = testEnv.CANONICAL_MEDIA_BUCKET;
  const originalGet = base.get.bind(base);
  let pulls = 0;
  const bucket = new Proxy(base, {
    get(target, property) {
      if (property === 'get') return async (...args: Parameters<R2Bucket['get']>) => {
        const object = await originalGet(...args);
        if (!object || !('body' in object)) return object;
        await object.body.cancel();
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            pulls += 1;
            await onPull(offset);
            if (offset === bytes.length) { controller.close(); return; }
            const end = Math.min(offset + FRAGMENT_BYTES, bytes.length);
            controller.enqueue(bytes.slice(offset, end));
            offset = end;
          },
        }, { highWaterMark: 0 });
        return new Proxy(object, {
          get(source, key) {
            if (key === 'body') return body;
            const value = Reflect.get(source, key, source) as unknown;
            return typeof value === 'function' ? value.bind(source) : value;
          },
        });
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env = Object.create(testEnv) as AppEnv;
  Object.defineProperty(env, 'CANONICAL_MEDIA_BUCKET', { value: bucket });
  return { env, pulls: () => pulls };
}

describe('Album ZIP preparation performance', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // The upload fixture opens its September 19 event early.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    await resetDatabase();
  });
  afterEach(() => vi.useRealTimers());

  it('prepares two original photos without a database round trip for every transport fragment', async () => {
    const { job, bytes, now, repository } = await albumFixture();
    const source = fragmentedBucket(bytes);
    const checks = vi.spyOn(ExportsRepository.prototype, 'assertOwnedRunActive');
    const result = await processExport(source.env, { jobId: job.id, attempt: 1 }, now);
    expect(result).toMatchObject({ state: 'ready', mediaCount: 2, totalBytes: PHOTO_BYTES * 2 });
    const [part] = await repository.listParts(job.id);
    const object = await testEnv.MEDIA_BUCKET.get(part!.objectKey);
    const files = unzipSync(new Uint8Array(await object!.arrayBuffer()));
    const names = Object.keys(files);
    expect(names).toHaveLength(3);
    expect(names[2]).toBe('media.csv');
    for (const name of names.slice(0, 2)) {
      expect(await crypto.subtle.digest('SHA-256', Uint8Array.from(files[name]!).buffer))
        .toEqual(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer));
    }
    expect(source.pulls()).toBeGreaterThan(280);
    expect(checks.mock.calls.length).toBeLessThanOrEqual(32);
  });

  it.each(['first fragment', 'completion'] as const)(
    'stops an Album deleted during the %s before publishing the ZIP', async phase => {
      const { access, job, bytes, now, repository } = await albumFixture();
      let deleted = false;
      const source = fragmentedBucket(bytes, async offset => {
        if (deleted || offset !== (phase === 'completion' ? bytes.length : 0)) return;
        deleted = true;
        await testEnv.DB.prepare('UPDATE events SET deleted_at=? WHERE id=?')
          .bind(now.toISOString(), access.event.id).run();
      });
      const result = await processExport(source.env, { jobId: job.id, attempt: 1 }, now);
      expect(result).toMatchObject({ state: 'failed', errorCode: 'EXPORT_EVENT_DELETED' });
      expect(await repository.listParts(job.id)).toEqual([]);
      expect(source.pulls()).toBeLessThanOrEqual(phase === 'completion' ? 144 : 64);
    },
  );
});

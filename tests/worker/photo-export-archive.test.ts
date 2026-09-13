import { beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { PhotoExportsRepository } from '../../worker/db/photo-exports';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { cleanupExpiredExports } from '../../worker/workflows/cleanup';
import { AuthService } from '../../worker/auth/service';
import { createApp } from '../../worker/app';
import { eventAccess, resetDatabase, testEnv, uploadPending, writeHeaders, png } from './helpers';

let access: Awaited<ReturnType<typeof eventAccess>>;
let photos: Array<Awaited<ReturnType<typeof uploadPending>>>;
let principal: string;
let now: Date;
let repository: PhotoExportsRepository;
async function selection(destination: 'archive' | 'device' = 'archive') {
  return repository.create({ eventId: access.event.id, principal, now: now.toISOString(), request: {
    version: 1, destination, idempotencyKey: crypto.randomUUID(),
    source: { mode: 'all', scope: 'library', filter: { order: 'newest' }, excludedMediaIds: [] },
  } });
}
beforeEach(async () => {
  await resetDatabase(); access = await eventAccess(); photos = [];
  for (let i = 0; i < 2; i++) photos.push(await uploadPending(access, crypto.randomUUID()));
  const token = /candidary_session=([^;]+)/u.exec(access.manager.cookie)![1]!;
  const auth = await new AuthService(testEnv).resolve(token); principal = `link:${auth.session.id}`;
  now = new Date(); repository = new PhotoExportsRepository(testEnv.DB);
  await testEnv.DB.prepare(`UPDATE photo_export_admission SET enabled=1,worker_version_id=?,admitted_at=?`).bind(crypto.randomUUID(), now.toISOString()).run();
});
describe('selected photo archives', () => {
  it('requires fresh confirmation and rejects device jobs at processor entrance', async () => {
    const archive = await selection();
    expect((await processExport(testEnv, { jobId: archive.id, attempt: 1 }, now))?.state).toBe('queued');
    await repository.cancel(access.event.id, archive.id, principal, now.toISOString());
    const device = await selection('device'); await repository.confirm(access.event.id, device.id, principal, now.toISOString());
    const before = await new ExportsRepository(testEnv.DB).getById(device.id);
    expect(await processExport(testEnv, { jobId: device.id, attempt: 1 }, now)).toEqual(before);
  });
  it('preserves frozen selection order, original bytes and photo metadata without Guestbook artifacts', async () => {
    const job = await selection(); await repository.confirm(access.event.id, job.id, principal, now.toISOString());
    const frozen = await repository.listEntries(access.event.id, job.id, principal, 0, 100, now.toISOString());
    const ready = await processExport(testEnv, { jobId: job.id, attempt: 1 }, now);
    expect(ready?.state).toBe('ready'); expect(ready?.partCount).toBe(1);
    const part = (await new ExportsRepository(testEnv.DB).listParts(job.id))[0]!;
    const object = await testEnv.MEDIA_BUCKET.get(part.objectKey);
    const files = unzipSync(new Uint8Array(await object!.arrayBuffer()));
    const names = Object.keys(files);
    expect(names).toEqual(frozen.entries.map((entry, index) => `photos/${String(index + 1).padStart(3, '0')}-${entry.filename}`).concat('media.csv'));
    expect(files[names[0]!]).toEqual(png());
    expect(strFromU8(files['media.csv']!)).toContain(frozen.entries[0]!.mediaId);
    expect(names.join(' ')).not.toMatch(/guestbook/i);
    expect(ready).toMatchObject({ guestbookEntryCount: null, guestbookHtmlObjectKey: null, guestbookCsvObjectKey: null });
    const download = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, { method: 'POST', headers: writeHeaders(access.manager), body: '{}' }, testEnv);
    expect(download.status).toBe(200); expect((await download.json<any>()).data).toMatchObject({ printableGuestbook: null, privateGuestbook: null });
  });
  it('resumes one selection owner without resetting monotonic progress', async () => {
    const job = await selection(); await repository.confirm(access.event.id, job.id, principal, now.toISOString());
    const exports = new ExportsRepository(testEnv.DB);
    const claim = await exports.claimRunning(job.id, 1, now.toISOString()); expect(claim.status).toBe('claimed');
    if (claim.status === 'lost') throw new Error('missing claim');
    expect(await exports.recordProgress(claim.owner, { processedMediaCount: 1, processedBytes: 64, progressUpdatedAt: now.toISOString() })).toBe(true);
    const ready = await processExport(testEnv, { jobId: job.id, attempt: 1 }, now, 64, now.toISOString());
    expect(ready).toMatchObject({ state: 'ready', processedMediaCount: 2, processedBytes: 128, partCount: 2 });
  });
  it('fences archive deadline progress and retires undispatched queued selections in bounded cleanup', async () => {
    const job = await selection(); await repository.confirm(access.event.id, job.id, principal, now.toISOString());
    const late = new Date(Date.parse(job.absoluteExpiresAt) + 1);
    expect((await processExport(testEnv, { jobId: job.id, attempt: 1 }, now, 64, now.toISOString(), () => late))?.state).not.toBe('ready');
    await cleanupExpiredExports(testEnv, late);
    expect((await new ExportsRepository(testEnv.DB).getById(job.id))?.state).toBe('expired');
    expect(await new ExportsRepository(testEnv.DB).listParts(job.id)).toEqual([]);
  });
  it('retries a failed selection as unconfirmed without legacy route bypass', async () => {
    const job = await selection(); await repository.confirm(access.event.id, job.id, principal, now.toISOString());
    const exports = new ExportsRepository(testEnv.DB);
    const claim = await exports.claimRunning(job.id, 1, now.toISOString()); expect(claim.status).toBe('claimed');
    if (claim.status === 'lost') throw new Error('missing claim');
    await exports.markOwnedFailed(claim.owner, 'EXPORT_FAILED', now.toISOString());
    const oldRetry = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/retry`, { method: 'POST', headers: writeHeaders(access.manager), body: '{}' }, testEnv);
    expect(oldRetry.status).toBe(409);
    const retried = await repository.retryArchive(access.event.id, job.id, principal, now.toISOString());
    expect(retried).toMatchObject({ attempt: 2, state: 'queued', confirmedAt: null, mediaCount: 2 });
    expect((await processExport(testEnv, { jobId: job.id, attempt: 2 }, now))?.state).toBe('queued');
  });
  it('retires prior Ready part inventory atomically when retrying an expired selection', async () => {
    const job = await selection(); await repository.confirm(access.event.id, job.id, principal, now.toISOString());
    const ready = await processExport(testEnv, { jobId: job.id, attempt: 1 }, now);
    expect(ready?.state).toBe('ready');
    const exports = new ExportsRepository(testEnv.DB);
    const [candidate] = await exports.listExpiredReady(ready!.expiresAt!);
    expect((await exports.markExpired(candidate!, ready!.expiresAt!)).changed).toBe(true);
    expect(await exports.listParts(job.id)).toHaveLength(1);
    const retried = await repository.retryArchive(access.event.id, job.id, principal, now.toISOString());
    expect(retried.confirmedAt).toBe(null);
    expect(await exports.listParts(job.id)).toEqual([]);
    await repository.confirm(access.event.id, job.id, principal, now.toISOString());
    expect((await processExport(testEnv, { jobId: job.id, attempt: 2 }, now))?.state).toBe('ready');
  });
  it('preserves legacy complete Guestbook outputs and Album photo-only outputs', async () => {
    const exports = new ExportsRepository(testEnv.DB);
    const full = await exports.createActive({ id: crypto.randomUUID(), eventId: access.event.id, snapshotAt: now.toISOString(), createdAt: now.toISOString() });
    const complete = await processExport(testEnv, { jobId: full.id, attempt: 1 }, now);
    expect(complete).toMatchObject({ state: 'ready', kind: 'complete', guestbookHtmlObjectKey: expect.any(String), guestbookCsvObjectKey: expect.any(String) });
    await testEnv.DB.prepare('UPDATE media SET favorited_at=? WHERE event_id=?').bind(now.toISOString(), access.event.id).run();
    await testEnv.DB.prepare('INSERT INTO event_albums (event_id,entries,saved_at,created_at,updated_at) VALUES (?,?,?,?,?)')
      .bind(access.event.id, JSON.stringify(photos.map(photo => ({ kind: 'photo', mediaId: photo.id }))), now.toISOString(), now.toISOString(), now.toISOString()).run();
    const album = await exports.createAlbumActive({ id: crypto.randomUUID(), eventId: access.event.id, snapshotAt: now.toISOString(), createdAt: now.toISOString() });
    expect(await processExport(testEnv, { jobId: album.id, attempt: 1 }, now)).toMatchObject({ state: 'ready', kind: 'album', guestbookHtmlObjectKey: null, guestbookCsvObjectKey: null });
  });
});

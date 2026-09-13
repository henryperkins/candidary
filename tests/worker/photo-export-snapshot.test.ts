import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { orderedMigrations } from './helpers';
import { PhotoExportsRepository } from '../../worker/db/photo-exports';
import type { CreatePhotoExportRequest } from '../../shared/photo-exports';

const db = env.DB;
let now: string;
let repository: PhotoExportsRepository;
const eventId = 'event';
const principal = 'link:manager';
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const id = (n: number) => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;
const request = (source: CreatePhotoExportRequest['source'] = { mode: 'all', scope: 'library', filter: { order: 'oldest' }, excludedMediaIds: [] }, destination: 'device' | 'archive' = 'device'): CreatePhotoExportRequest => ({ version: 1, idempotencyKey: crypto.randomUUID(), source, destination });
async function event(key = eventId) {
  await db.batch([
    db.prepare(`INSERT INTO events (id, slug, name, event_date, welcome_message, guest_access_expires_at,
      management_access_expires_at, purge_after, created_at) VALUES (?, ?, 'Event', '2026-09-19', 'Welcome', ?, ?, ?, ?)`).bind(key, key, at(10_000), at(10_000), at(10_000), now),
    db.prepare(`INSERT INTO event_access_tokens (id, event_id, role, secret_digest, expires_at, created_at)
      VALUES (?, ?, 'manager', 'digest', ?, ?)`).bind(`${key}-token`, key, at(10_000), now),
    db.prepare(`INSERT INTO event_sessions (id, event_id, access_token_id, role, secret_digest, csrf_digest, expires_at, created_at)
      VALUES (?, ?, ?, 'manager', 'digest', 'csrf', ?, ?)`).bind(key === eventId ? 'manager' : `${key}-manager`, key, `${key}-token`, at(10_000), now),
  ]);
}
async function photos(count = 3, key = eventId, offset = 0) {
  const ids = Array.from({ length: count }, (_, i) => id(i + offset + 1));
  // One JSON binding also keeps large fixtures comfortably below D1's limits.
  await db.batch([
    db.prepare(`INSERT INTO media (id, event_id, uploader_session_id, object_key, object_bucket_generation,
      original_filename, mime_type, declared_byte_size, byte_size, guest_name, upload_state, publication_status,
      idempotency_key, reservation_expires_at, created_at, stored_at, timeline_at)
      SELECT value, ?2, ?3, 'events/' || ?2 || '/media/final/' || value, 'canonical', value || '.jpg',
      'image/jpeg', 12, 12, 'Guest', 'stored', 'unpublished', value, ?4, ?4, ?4, ?4 FROM json_each(?1)`)
      .bind(JSON.stringify(ids), key, key === eventId ? 'manager' : `${key}-manager`, now),
    db.prepare(`INSERT OR IGNORE INTO media_object_write_tombstones (bucket_generation, object_key, event_id, media_id,
      object_kind, created_at, next_check_at, updated_at) SELECT 'canonical', object_key, event_id, id,
      'final', ?2, ?2, ?2 FROM media WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids), now),
  ]);
  return ids;
}
async function open() {
  await db.prepare(`UPDATE export_protocol_admission SET state='closed', closed_at=?`).bind(now).run();
  await db.prepare(`UPDATE export_protocol_admission SET state='open', worker_version_id=?, admitted_at=?`).bind(id(999), now).run();
  await db.prepare(`UPDATE photo_export_admission SET enabled=1, worker_version_id=?, admitted_at=?`).bind(id(999), now).run();
}
const create = (req = request()) => repository.create({ eventId, principal, request: req, now });
async function failArchive(jobId: string) {
  await db.prepare(`UPDATE export_jobs SET state='running', execution_transition=execution_transition+1,
    execution_started_at=?, processed_media_count=0, processed_bytes=0, progress_updated_at=? WHERE id=?`).bind(now, now, jobId).run();
  await db.prepare(`UPDATE export_jobs SET state='failed', execution_transition=execution_transition+1,
    error_code='EXPORT_FAILED' WHERE id=?`).bind(jobId).run();
}
async function expiredArchiveWithParts() {
  await photos(1);
  const job=await create(request(undefined,'archive'));
  await repository.confirm(eventId,job.id,principal,now);
  await db.batch([
    db.prepare(`UPDATE export_jobs SET state='running',execution_transition=execution_transition+1,
      execution_started_at=?,processed_media_count=0,processed_bytes=0,progress_updated_at=? WHERE id=?`).bind(now,now,job.id),
    db.prepare(`INSERT INTO export_parts (id,export_job_id,part_number,object_key,media_count,source_bytes,created_at)
      VALUES (?, ?, 1, 'old-attempt/part-1.zip', 1, 12, ?)`).bind(crypto.randomUUID(),job.id,now),
    db.prepare(`UPDATE export_jobs SET state='ready',execution_transition=execution_transition+1,
      processed_media_count=media_count,processed_bytes=total_bytes,progress_updated_at=?,completed_at=?,
      manifest_object_key='old-attempt/manifest.json',part_count=1,expires_at=? WHERE id=?`).bind(now,now,at(1),job.id),
    db.prepare(`UPDATE export_jobs SET state='expired',execution_transition=execution_transition+1 WHERE id=?`).bind(job.id),
  ]);
  return job;
}
beforeEach(async () => {
  await reset(); await applyD1Migrations(db, orderedMigrations);
  // Never use fake timers: migration lease guards deliberately read SQLite's real clock.
  now = new Date().toISOString(); repository = new PhotoExportsRepository(db);
  await event(); await open();
});

describe('photo export atomic snapshots', () => {
  it('freezes Gallery order and literal filters, and replays exactly despite later changes', async () => {
    const ids = await photos();
    await db.prepare(`UPDATE media SET caption='100%_literal', favorited_at=? WHERE id IN (?, ?)`).bind(now, ids[0], ids[2]).run();
    const req = request({ mode: 'all', scope: 'library', filter: { query: '%_', favorites: true, order: 'oldest' }, excludedMediaIds: [] });
    const job = await create(req);
    expect(job).toMatchObject({ mediaCount: 2, totalBytes: 24, state: 'queued', confirmedAt: null });
    await photos(1, eventId, 4);
    await db.prepare(`UPDATE media SET caption=NULL, favorited_at=NULL`).run();
    expect((await repository.listEntries(eventId, job.id, principal, 0, 100, now)).entries.map(e => e.mediaId)).toEqual([ids[0], ids[2]]);
    expect((await create(req)).id).toBe(job.id);
    await expect(create({ ...req, destination: 'archive' })).rejects.toMatchObject({ status: 409 });
    const page = await repository.listEntries(eventId, job.id, principal, 0, 1, now);
    expect(page.nextPosition).toBe(1);
    expect((await repository.listEntries(eventId, job.id, principal, 1, 1, now)).entries[0]?.mediaId).toBe(ids[2]);
    expect(JSON.stringify(page)).not.toMatch(/object_key|objectKey|initiating_principal/);
  });
  it('freezes Album stored order followed by unplaced picks and applies exclusions', async () => {
    const ids = await photos(4);
    await db.prepare(`UPDATE media SET favorited_at=?`).bind(now).run();
    await db.prepare(`INSERT INTO event_albums (event_id, entries, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(eventId, JSON.stringify([{ kind: 'photo', mediaId: ids[2] }, { kind: 'section', id: 's', heading: 'Notes' }, { kind: 'photo', mediaId: ids[0] }]), now, now).run();
    const job = await create(request({ mode: 'all', scope: 'album', excludedMediaIds: [ids[3]!] }));
    await db.prepare(`UPDATE event_albums SET entries='[]'`).run();
    await db.prepare(`UPDATE media SET favorited_at=NULL`).run();
    expect((await repository.listEntries(eventId, job.id, principal, 0, 100, now)).entries.map(e => e.mediaId)).toEqual([ids[2], ids[0], ids[1]]);
  });
  it('accepts 10,000 IDs through one JSON parameter with no statement over 100 bindings', async () => {
    const ids = await photos(10_000);
    const sizes: number[] = []; let largeJson = false;
    const recording = new Proxy(db, { get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, { get(stmt, key) {
          if (key === 'bind') return (...values: unknown[]) => {
            sizes.push(values.length); if (values.length > 100) throw new Error('D1 binding ceiling');
            largeJson ||= values.some(value => typeof value === 'string' && value.startsWith('[') && value.length > 300_000);
            return stmt.bind(...values);
          };
          const value = Reflect.get(stmt, key, stmt); return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    repository = new PhotoExportsRepository(recording);
    const job = await create(request({ mode: 'ids', scope: 'library', mediaIds: ids.reverse() }));
    expect(job).toMatchObject({ mediaCount: 10_000, totalBytes: 120_000 });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100); expect(largeJson).toBe(true);
    expect((await repository.listEntries(eventId, job.id, principal, 9999, 100, now)).entries.map(e => e.mediaId)).toEqual([id(10_000)]);
    await repository.cancel(eventId, job.id, principal, now); await photos(1,eventId,10_000);
    await expect(create()).rejects.toMatchObject({ code: 'EXPORT_LIMIT_EXCEEDED', status: 400 });
  });
  it('rejects duplicate, omitted, cross-event and outside-Album IDs without a partial job', async () => {
    const ids = await photos(1); await event('other'); const foreign = await photos(1, 'other', 5);
    for (const source of [
      { mode: 'ids', scope: 'library', mediaIds: [ids[0], ids[0]] },
      { mode: 'ids', scope: 'library', mediaIds: [ids[0], id(99)] },
      { mode: 'ids', scope: 'library', mediaIds: [ids[0], foreign[0]] },
      { mode: 'ids', scope: 'album', mediaIds: ids },
    ] as CreatePhotoExportRequest['source'][]) await expect(create(request(source))).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await db.prepare('SELECT count(*) AS n FROM export_jobs').first('n')).toBe(0);
  });
  it('keeps admission and one-active-operation enforcement atomic', async () => {
    await photos(); await db.prepare(`UPDATE photo_export_admission SET enabled=0, worker_version_id=NULL, admitted_at=NULL`).run();
    await expect(create()).rejects.toMatchObject({ status: 503 });
    await db.prepare(`UPDATE photo_export_admission SET enabled=1, worker_version_id=?, admitted_at=?`).bind(id(999), now).run();
    const outcomes = await Promise.allSettled([create(), create()]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'EXPORT_ALREADY_ACTIVE', status: 409 } });
    await expect(create({ ...request(), destination: 'google-photos' })).rejects.toMatchObject({ status: 503 });
  });
  it('suppression wins before admission; the accepted snapshot wins before suppression', async () => {
    const ids = await photos(2);
    await db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=? WHERE media_id=?`).bind(now, ids[0]).run();
    await expect(create(request({ mode: 'ids', scope: 'library', mediaIds: ids }))).rejects.toMatchObject({ code: 'EXPORT_SOURCE_REMOVED', status: 409 });
    expect(await db.prepare('SELECT count(*) AS n FROM export_jobs').first('n')).toBe(0);
    const job = await create(); expect(job.mediaCount).toBe(1);
    await expect(db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=? WHERE media_id=?`).bind(now, ids[1]).run()).rejects.toThrow(/holds this source/);
  });
});

describe('photo export device ownership', () => {
  it('clamps device holds and archive attempts to their respective absolute/event deadlines', async () => {
    await photos(); let job = await create();
    expect(job.holdExpiresAt).toBe(at(30)); expect(job.absoluteExpiresAt).toBe(at(1440));
    job = await repository.confirm(eventId, job.id, principal, at(10));
    expect(job).toMatchObject({ state: 'running', holdExpiresAt: at(40), absoluteExpiresAt: at(1440) });
    expect((await repository.confirm(eventId, job.id, principal, at(11))).holdExpiresAt).toBe(at(40));
    await repository.cancel(eventId, job.id, principal, at(11));
    job = await create(request(undefined, 'archive'));
    expect(job.absoluteExpiresAt).toBe(at(10_000));
    job = await repository.confirm(eventId, job.id, principal, at(10));
    expect(job).toMatchObject({ state: 'queued', holdExpiresAt: at(1450) });
    expect(await db.prepare('SELECT execution_started_at FROM export_jobs WHERE id=?').bind(job.id).first('execution_started_at')).toBeNull();
    await repository.cancel(eventId, job.id, principal, at(11));
    await db.prepare('UPDATE events SET management_access_expires_at=?, purge_after=?').bind(at(15), at(12)).run();
    job = await create(); expect(job.holdExpiresAt).toBe(at(12)); expect(job.absoluteExpiresAt).toBe(at(12));
  });
  it('protects receipts and read grants from other principals and revoked event authority', async () => {
    await photos(); const job = await create(); await repository.confirm(eventId, job.id, principal, now);
    await expect(repository.get(eventId, job.id, 'link:someone-else', now)).rejects.toMatchObject({ status: 404 });
    await expect(repository.claimRead(eventId, job.id, id(1), 'link:someone-else', now)).rejects.toMatchObject({ status: 404 });
    const lease = await repository.claimRead(eventId, job.id, id(1), principal, now);
    await db.prepare(`UPDATE event_access_tokens SET revoked_at=?`).bind(now).run();
    expect(await repository.assertReadActive(lease, now)).toBe(false);
    await repository.releaseRead(lease, 'prepared', now);
    expect(await db.prepare('SELECT state FROM photo_export_deliveries WHERE media_id=?').bind(id(1)).first('state')).toBe('pending');
    await expect(repository.recordHandoff(eventId, job.id, principal, [id(1)], now)).rejects.toMatchObject({ status: 404 });
  });
  it('bounds reads, preserves cancellation holds while draining, and ignores retired callbacks', async () => {
    const ids = await photos(); const job = await create(); await repository.confirm(eventId, job.id, principal, now);
    const first = await repository.claimRead(eventId, job.id, ids[0]!, principal, now);
    const second = await repository.claimRead(eventId, job.id, ids[1]!, principal, now);
    expect(first.leaseExpiresAt).toBe(at(2));
    await expect(repository.claimRead(eventId, job.id, ids[2]!, principal, now)).rejects.toMatchObject({ status: 409 });
    const retiring = await repository.cancel(eventId, job.id, principal, now);
    expect(retiring).toMatchObject({ state: 'running', cancelRequested: true });
    expect(await repository.assertReadActive(first, now)).toBe(false);
    await expect(repository.recordHandoff(eventId, job.id, principal, [ids[0]!], now)).rejects.toMatchObject({ status: 409 });
    await expect(db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=?`).bind(now).run()).rejects.toThrow();
    await repository.releaseRead(first, 'prepared', now);
    await repository.releaseRead(second, 'failed', now);
    expect(await repository.get(eventId, job.id, principal, now)).toMatchObject({ state: 'cancelled', handedOffCount: 0 });
    await repository.releaseRead(first, 'prepared', now);
    expect(await db.prepare(`SELECT count(*) AS n FROM photo_export_deliveries WHERE state<>'pending'`).first('n')).toBe(0);
    await db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=?`).bind(now).run();
  });
  it('records reported handoffs exactly once using frozen original bytes and keeps failures visible', async () => {
    const ids = await photos(2); const job = await create(); await repository.confirm(eventId, job.id, principal, now);
    const first = await repository.claimRead(eventId, job.id, ids[0]!, principal, now);
    await repository.releaseRead(first, 'prepared', at(1));
    const second = await repository.claimRead(eventId, job.id, ids[1]!, principal, now);
    await repository.releaseRead(second, 'failed', at(1));
    await expect(repository.recordHandoff(eventId, job.id, principal, ids, at(1))).rejects.toMatchObject({ status: 409 });
    let receipt = await repository.recordHandoff(eventId, job.id, principal, [ids[0]!, ids[0]!], at(2));
    expect(receipt).toMatchObject({ handedOffCount: 1, unavailableCount: 1, state: 'running', holdExpiresAt: at(32) });
    receipt = await repository.recordHandoff(eventId, job.id, principal, [ids[0]!], at(3));
    expect(receipt.holdExpiresAt).toBe(at(32));
    expect(await db.prepare('SELECT processed_bytes FROM export_jobs WHERE id=?').bind(job.id).first('processed_bytes')).toBe(12);
    const retry = await repository.claimRead(eventId, job.id, ids[1]!, principal, at(3));
    await repository.releaseRead(retry, 'prepared', at(3));
    receipt = await repository.recordHandoff(eventId, job.id, principal, [ids[1]!], at(3));
    expect(receipt).toMatchObject({ state: 'handed-off', handedOffCount: 2, unavailableCount: 0 });
  });
  it('expires bounded holds and prevents expired reads from publishing prepared state', async () => {
    await photos(1); const job = await create(); await repository.confirm(eventId, job.id, principal, now);
    const lease = await repository.claimRead(eventId, job.id, id(1), principal, now);
    expect(await repository.assertReadActive(lease, at(3))).toBe(false);
    await repository.releaseRead(lease, 'prepared', at(3));
    expect((await repository.listEntries(eventId, job.id, principal, 0, 10, at(3))).entries[0]?.state).toBe('pending');
    expect(await repository.expireActive(at(31), 10)).toBe(1);
    expect(await repository.get(eventId, job.id, principal, at(31))).toMatchObject({ state: 'expired', absoluteExpiresAt: at(1440) });
  });
  it('retries only failed/expired archives with exact source reacquisition and fresh confirmation', async () => {
    await photos(2); const job = await create(request(undefined, 'archive')); await repository.confirm(eventId, job.id, principal, now);
    await failArchive(job.id);
    let retried = await repository.retryArchive(eventId, job.id, principal, at(5));
    expect(retried).toMatchObject({ state: 'queued', attempt: 2, confirmedAt: null, holdExpiresAt: at(35), absoluteExpiresAt: job.absoluteExpiresAt });
    await repository.confirm(eventId, job.id, principal, at(5)); await failArchive(job.id);
    await db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=? WHERE media_id=?`).bind(now, id(1)).run();
    await expect(repository.retryArchive(eventId, job.id, principal, at(6))).rejects.toMatchObject({ code: 'EXPORT_SOURCE_REMOVED', status: 409 });
    retried = await repository.get(eventId, job.id, principal, at(6)); expect(retried).toMatchObject({ state: 'failed', attempt: 2, mediaCount: 2 });
  });
  it('requires explicit archive fallback, drains reads, clones exact inventory and preserves old receipts', async () => {
    const ids = await photos(2); const job = await create(); await repository.confirm(eventId, job.id, principal, now);
    const first = await repository.claimRead(eventId, job.id, ids[0]!, principal, now);
    await repository.releaseRead(first, 'prepared', now); await repository.recordHandoff(eventId, job.id, principal, [ids[0]!], now);
    const second = await repository.claimRead(eventId, job.id, ids[1]!, principal, now);
    const key = crypto.randomUUID();
    await expect(repository.prepareArchiveFallback(eventId, job.id, principal, key, now)).rejects.toMatchObject({ status: 409 });
    await repository.releaseRead(second, 'prepared', now);
    expect(await repository.get(eventId,job.id,principal,now)).toMatchObject({ state: 'running',cancelRequested: true,errorCode: null });
    await expect(db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=? WHERE media_id=?`).bind(now,ids[1]).run()).rejects.toThrow(/holds this source/);
    await photos(1, eventId, 5);
    const archive = await repository.prepareArchiveFallback(eventId, job.id, principal, key, now);
    expect(archive).toMatchObject({ destination: 'archive', state: 'queued', confirmedAt: null, mediaCount: 2 });
    expect((await repository.listEntries(eventId, archive.id, principal, 0, 10, now)).entries.map(e => e.mediaId)).toEqual(ids);
    expect((await repository.prepareArchiveFallback(eventId, job.id, principal, key, now)).id).toBe(archive.id);
    expect(await repository.get(eventId, job.id, principal, now)).toMatchObject({ state: 'cancelled', handedOffCount: 1 });
    await expect(db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=? WHERE media_id=?`).bind(now, ids[1]).run()).rejects.toThrow();
  });
  it('atomically clears retained ready-to-expired archive parts only when retry wins', async () => {
    const job=await expiredArchiveWithParts();
    expect((await db.prepare(`SELECT * FROM export_parts WHERE export_job_id=?`).bind(job.id).all()).results).toHaveLength(1);
    const frozen=(await db.prepare(`SELECT * FROM export_media_entries WHERE export_job_id=?`).bind(job.id).all()).results;
    const retried=await repository.retryArchive(eventId,job.id,principal,at(5));
    expect(retried).toMatchObject({ state: 'queued',attempt: 2,confirmedAt: null,holdExpiresAt: at(35),absoluteExpiresAt: job.absoluteExpiresAt });
    expect((await db.prepare(`SELECT * FROM export_parts WHERE export_job_id=?`).bind(job.id).all()).results).toEqual([]);
    expect((await db.prepare(`SELECT * FROM export_media_entries WHERE export_job_id=?`).bind(job.id).all()).results).toEqual(frozen);
  });
  it('preserves retained archive parts when admission, source reacquisition, or an active job refuses retry', async () => {
    const job=await expiredArchiveWithParts();
    const parts=(await db.prepare(`SELECT * FROM export_parts WHERE export_job_id=?`).bind(job.id).all()).results;
    await db.prepare(`UPDATE photo_export_admission SET enabled=0,worker_version_id=NULL,admitted_at=NULL`).run();
    await expect(repository.retryArchive(eventId,job.id,principal,at(5))).rejects.toMatchObject({ status: 503 });
    expect((await db.prepare(`SELECT * FROM export_parts WHERE export_job_id=?`).bind(job.id).all()).results).toEqual(parts);
    await db.prepare(`UPDATE photo_export_admission SET enabled=1,worker_version_id=?,admitted_at=?`).bind(id(999),now).run();
    await db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=? WHERE media_id=?`).bind(now,id(1)).run();
    await expect(repository.retryArchive(eventId,job.id,principal,at(5))).rejects.toMatchObject({ code: 'EXPORT_SOURCE_REMOVED',status: 409 });
    expect((await db.prepare(`SELECT * FROM export_parts WHERE export_job_id=?`).bind(job.id).all()).results).toEqual(parts);
    await photos(1,eventId,1); await create();
    await expect(repository.retryArchive(eventId,job.id,principal,at(5))).rejects.toMatchObject({ code: 'EXPORT_ALREADY_ACTIVE',status: 409 });
    expect((await db.prepare(`SELECT * FROM export_parts WHERE export_job_id=?`).bind(job.id).all()).results).toEqual(parts);
    expect(await repository.get(eventId,job.id,principal,at(5))).toMatchObject({ state: 'expired',attempt: 1 });
  });
  it('preserves a frozen photo moved to recoverable trash before explicit archive fallback', async () => {
    await photos(1); const job=await create();
    await db.prepare(`UPDATE media SET trashed_at=?,deleted_at=?,restore_until=? WHERE id=?`).bind(now,now,at(60),id(1)).run();
    const archive=await repository.prepareArchiveFallback(eventId,job.id,principal,crypto.randomUUID(),now);
    expect(archive).toMatchObject({ destination: 'archive',state: 'queued',mediaCount: 1,totalBytes: 12 });
    expect((await repository.listEntries(eventId,archive.id,principal,0,10,now)).entries.map(e => e.mediaId)).toEqual([id(1)]);
    await expect(db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=? WHERE media_id=?`).bind(now,id(1)).run()).rejects.toThrow(/holds this source/);
  });
  it('returns a controlled conflict when another fallback wins immediately before the clone batch', async () => {
    await photos(1); const job = await create();
    let winner: string | undefined; let intercepted = false;
    const racing = new Proxy(db,{ get(target,property) {
      if (property==='batch') return async (statements: D1PreparedStatement[]) => {
        if (statements.length===4 && !intercepted) {
          intercepted=true;
          winner=(await repository.prepareArchiveFallback(eventId,job.id,principal,crypto.randomUUID(),now)).id;
        }
        return target.batch(statements);
      };
      const value=Reflect.get(target,property,target); return typeof value==='function' ? value.bind(target) : value;
    } });
    await expect(new PhotoExportsRepository(racing).prepareArchiveFallback(eventId,job.id,principal,crypto.randomUUID(),now))
      .rejects.toMatchObject({ code: 'EXPORT_ALREADY_ACTIVE',status: 409 });
    expect(await db.prepare(`SELECT id FROM export_jobs WHERE state='queued'`).first('id')).toBe(winner);
  });
  it('fences an old lease callback after a real expired lease is replaced', async () => {
    const realNow=now; now=at(-3); await photos(1);
    const job=await create(); await repository.confirm(eventId,job.id,principal,now);
    const old=await repository.claimRead(eventId,job.id,id(1),principal,now);
    const current=await repository.claimRead(eventId,job.id,id(1),principal,realNow);
    await repository.releaseRead(old,'prepared',realNow);
    expect(await repository.assertReadActive(current,realNow)).toBe(true);
    expect((await repository.listEntries(eventId,job.id,principal,0,10,realNow)).entries[0]?.state).toBe('pending');
    await repository.releaseRead(current,'prepared',realNow);
    expect((await repository.listEntries(eventId,job.id,principal,0,10,realNow)).entries[0]?.state).toBe('prepared');
  });
  it('authorizes account ownership while exposing only a minimal conflict projection to another manager', async () => {
    await photos(1); const job=await create();
    await db.batch([
      db.prepare(`INSERT INTO host_accounts (id,email,password_hash,created_at) VALUES ('account','host@example.com','hash',?)`).bind(now),
      db.prepare(`INSERT INTO event_hosts (event_id,account_id,role,created_at) VALUES (?,'account','owner',?)`).bind(eventId,now),
    ]);
    const capabilities=await repository.capabilities(eventId,'account:account');
    expect(capabilities.activeJob).toMatchObject({ id: job.id,ownedByCurrentPrincipal: false });
    expect(JSON.stringify(capabilities)).not.toMatch(/source|principal|link:manager/);
    await expect(repository.get(eventId,job.id,'account:account',now)).rejects.toMatchObject({ status: 404 });
    await repository.cancel(eventId,job.id,principal,now);
    const accountJob=await repository.create({ eventId,principal: 'account:account',request: request(),now });
    await repository.confirm(eventId,accountJob.id,'account:account',now);
    await db.prepare(`DELETE FROM event_hosts WHERE account_id='account'`).run();
    await expect(repository.claimRead(eventId,accountJob.id,id(1),'account:account',now)).rejects.toMatchObject({ status: 404 });
  });
});

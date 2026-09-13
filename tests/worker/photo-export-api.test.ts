import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../worker/app';
import { PhotoExportsRepository } from '../../worker/db/photo-exports';
import { ExportsRepository } from '../../worker/db/exports';
import type { AppEnv } from '../../worker/env';
import { eventAccess, resetDatabase, testEnv, uploadPending, writeHeaders, png, hostAccess, hostWriteHeaders, origin } from './helpers';

let access: Awaited<ReturnType<typeof eventAccess>>;
let media: Awaited<ReturnType<typeof uploadPending>>;
let base: string;
const now = () => new Date().toISOString();
const input = (destination = 'device') => ({ version: 1, idempotencyKey: crypto.randomUUID(), destination,
  source: { mode: 'all', scope: 'library', filter: { order: 'oldest' }, excludedMediaIds: [] } });
const post = (path: string, body: unknown = {}, appEnv = testEnv) => createApp().request(`${base}${path}`, {
  method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify(body),
}, appEnv);
async function create(destination = 'device') {
  const response = await post('', input(destination));
  expect(response.status).toBe(202);
  return (await response.json<any>()).data.export;
}
beforeEach(async () => {
  await resetDatabase(); access = await eventAccess(); media = await uploadPending(access, crypto.randomUUID());
  base = `/api/manage/events/${access.event.id}/photo-exports`;
  await testEnv.DB.prepare(`UPDATE photo_export_admission SET enabled=1,worker_version_id=?,admitted_at=?`)
    .bind(crypto.randomUUID(), now()).run();
});

describe('private photo export API', () => {
  it('returns private capabilities and frozen entries, and streams the exact original with safe metadata', async () => {
    const caps = await createApp().request(`${base}/capabilities`, { headers: { cookie: access.manager.cookie } }, testEnv);
    expect(caps.status).toBe(200); expect(caps.headers.get('cache-control')).toBe('private, no-store');
    const job = await create(); expect(job).toMatchObject({ mediaCount: 1, confirmedAt: null });
    expect(JSON.stringify(job)).not.toMatch(/objectKey|principal|leaseToken/);
    const confirmed = await post(`/${job.id}/confirm`); expect(confirmed.status).toBe(200);
    const file = await createApp().request(`${base}/${job.id}/entries/${media.id}/file`, { headers: { cookie: access.manager.cookie } }, testEnv);
    expect(file.status).toBe(200); expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('content-length')).toBe(String(png().byteLength));
    expect(file.headers.get('content-disposition')).toContain(media.originalFilename);
    expect(file.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(png());
    const entries = await createApp().request(`${base}/${job.id}/entries?after=0`, { headers: { cookie: access.manager.cookie } }, testEnv);
    expect((await entries.json<any>()).data.entries[0]).toMatchObject({ mediaId: media.id, state: 'prepared', byteSize: 64 });
    expect((await (await post(`/${job.id}/handoff`, { mediaIds: [media.id] })).json<any>()).data.export).toMatchObject({ state: 'handed-off', handedOffCount: 1 });
  });
  it('rejects guest and Album-only credentials before any original read', async () => {
    const job = await create(); await post(`/${job.id}/confirm`);
    await testEnv.DB.prepare('UPDATE media SET favorited_at=? WHERE id=?').bind(now(), media.id).run();
    await testEnv.DB.prepare('INSERT INTO event_albums (event_id,entries,saved_at,created_at,updated_at) VALUES (?,?,?,?,?)')
      .bind(access.event.id, JSON.stringify([{ kind: 'photo', mediaId: media.id }]), now(), now(), now()).run();
    const shared = await createApp().request(`/api/manage/events/${access.event.id}/album/share`, { method: 'POST', headers: writeHeaders(access.manager) }, testEnv);
    expect(shared.status).toBe(200);
    const url = (await shared.json<any>()).data.share.url;
    const exchanged = await createApp().request('/api/album-share/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) }, testEnv);
    expect(exchanged.status).toBe(200);
    const albumCookie = /candidary_album=[^;,]+/u.exec(exchanged.headers.get('set-cookie')!)![0];
    for (const cookie of [access.guest.cookie, albumCookie, '']) {
      const response = await createApp().request(`${base}/${job.id}/entries/${media.id}/file`, { headers: { cookie } }, testEnv);
      expect([401, 403]).toContain(response.status);
    }
    expect((await testEnv.DB.prepare(`SELECT count(*) AS n FROM photo_export_deliveries WHERE read_lease_token IS NOT NULL`).first<any>()).n).toBe(0);
  });
  it('checks retirement before the next source chunk and releases the draining hold', async () => {
    const job = await create(); await post(`/${job.id}/confirm`);
    let pulls = 0;
    const bucket = new Proxy(testEnv.CANONICAL_MEDIA_BUCKET, { get(target, property) {
      if (property === 'get') return async (key: string) => {
        const object = await target.get(key);
        return { ...object, body: new ReadableStream<Uint8Array>({ pull(controller) {
          pulls++; controller.enqueue(png().slice(0,32)); if (pulls === 2) controller.close();
        } }, { highWaterMark: 0 }) };
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const fixture = Object.create(testEnv) as AppEnv; Object.defineProperty(fixture, 'CANONICAL_MEDIA_BUCKET', { value: bucket });
    const file = await createApp().request(`${base}/${job.id}/entries/${media.id}/file`, { headers: { cookie: access.manager.cookie } }, fixture);
    expect(file.status).toBe(200);
    const reader = file.body!.getReader(); expect((await reader.read()).value?.byteLength).toBe(32); expect(pulls).toBe(1);
    await post(`/${job.id}/cancel`);
    await expect(reader.read()).rejects.toBeDefined();
    expect(pulls).toBe(1);
    // The failing pull awaits lease release before resolving its underlying callback.
    await reader.cancel().catch(() => undefined);
    const pending = await testEnv.DB.prepare('SELECT state,read_lease_token FROM photo_export_deliveries WHERE export_job_id=?').bind(job.id).first<any>();
    expect(pending).toMatchObject({ state: 'pending', read_lease_token: null });
  });
  it('keeps a busy archive fallback recoverable through explicit retry or Cancel', async () => {
    const job = await create(); await post(`/${job.id}/confirm`);
    const file = await createApp().request(`${base}/${job.id}/entries/${media.id}/file`, { headers: { cookie: access.manager.cookie } }, testEnv);
    const key = crypto.randomUUID();
    expect((await post(`/${job.id}/archive`, { idempotencyKey: key })).status).toBe(409);
    const pending = await createApp().request(`${base}/${job.id}`, { headers: { cookie: access.manager.cookie } }, testEnv);
    expect((await pending.json<any>()).data.export).toMatchObject({ cancelRequested: true, errorCode: null, state: 'running' });
    await file.body!.cancel();
    const fallback = await post(`/${job.id}/archive`, { idempotencyKey: key });
    expect(fallback.status).toBe(200);
    expect((await fallback.json<any>()).data.export).toMatchObject({ destination: 'archive', state: 'queued', confirmedAt: null, mediaCount: 1 });
  });
  it('marks proven dispatch failure recoverable and retries through a fresh confirmation', async () => {
    const workflow = { createBatch: async () => [], get: async () => ({ status: async () => ({ status: 'errored' }) }) };
    const fixture = Object.create(testEnv) as typeof testEnv; Object.defineProperty(fixture, 'EXPORT_WORKFLOW', { value: workflow });
    const job = await create('archive');
    const confirmation = await post(`/${job.id}/confirm`, {}, fixture);
    expect(confirmation.status).toBe(200);
    expect((await confirmation.json<any>()).data.export).toMatchObject({ state: 'failed', errorCode: 'EXPORT_WORKFLOW_DISPATCH_FAILED' });
    const retry = await post(`/${job.id}/retry`);
    expect(retry.status).toBe(200); expect((await retry.json<any>()).data.export).toMatchObject({ attempt: 2, state: 'queued', confirmedAt: null });
  });
  it('authenticates and checks origin/CSRF before buffering every write and bounds streams without Content-Length', async () => {
    for (const suffix of ['', '/job/confirm', '/job/cancel', '/job/retry', '/job/handoff', '/job/archive']) {
      for (const headers of [{}, { ...writeHeaders(access.manager), origin: 'https://evil.example' }, { ...writeHeaders(access.manager), 'x-candidary-csrf': 'bad' }]) {
        const body = new ReadableStream<Uint8Array>({ pull() { throw new Error('body must not be read'); } }, { highWaterMark: 0 });
        const response = await createApp().request(`${base}${suffix}`, { method: 'POST', headers, body }, testEnv);
        expect([401,403]).toContain(response.status);
      }
    }
    const response = await createApp().request(base, { method: 'POST', headers: writeHeaders(access.manager),
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); c.close(); } }) }, testEnv);
    expect(response.status).toBe(422); expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
  });
  it('projects active conflict identity without another principal source and rejects oversized/duplicate/out-of-job handoff', async () => {
    const job = await create();
    const host = await hostAccess([access]);
    const conflict = await createApp().request(base, { method: 'POST', headers: hostWriteHeaders(host), body: JSON.stringify(input()) }, testEnv);
    expect(conflict.status).toBe(409);
    const body = await conflict.json<any>();
    expect(body.data).toMatchObject({ kind: 'active-export-conflict', activeJob: { id: job.id, mediaCount: 1, destination: 'device', ownedByCurrentPrincipal: false } });
    expect(JSON.stringify(body)).not.toMatch(/source|principal|secret|credential/);
    await post(`/${job.id}/confirm`);
    for (const mediaIds of [[media.id, media.id], Array.from({ length: 21 }, () => crypto.randomUUID()), ['bad']]) {
      expect((await post(`/${job.id}/handoff`, { mediaIds })).status).toBe(422);
    }
    expect((await post(`/${job.id}/handoff`, { mediaIds: [crypto.randomUUID()] })).status).toBe(409);
  });
  it('cancels an unconsumed file lease without publishing prepared progress', async () => {
    const job = await create(); await post(`/${job.id}/confirm`);
    const file = await createApp().request(`${base}/${job.id}/entries/${media.id}/file`, { headers: { cookie: access.manager.cookie } }, testEnv);
    expect(file.status).toBe(200);
    expect((await (await post(`/${job.id}/cancel`)).json<any>()).data.export.cancelRequested).toBe(true);
    await file.body!.cancel();
    const row = await testEnv.DB.prepare(`SELECT state, read_lease_token FROM photo_export_deliveries WHERE export_job_id=?`).bind(job.id).first<any>();
    expect(row).toMatchObject({ state: 'pending', read_lease_token: null });
    expect((await new ExportsRepository(testEnv.DB).getById(job.id))?.state).toBe('cancelled');
  });
  it('rejects mismatched original metadata, preserves failed entries and prevents late lease completion', async () => {
    const job = await create(); await post(`/${job.id}/confirm`);
    const bucket = media.objectBucketGeneration === 'canonical' ? testEnv.CANONICAL_MEDIA_BUCKET : testEnv.MEDIA_BUCKET;
    await bucket.put(media.objectKey, new Uint8Array(65), { httpMetadata: { contentType: 'image/png' } });
    const response = await createApp().request(`${base}/${job.id}/entries/${media.id}/file`, { headers: { cookie: access.manager.cookie } }, testEnv);
    expect(response.status).toBe(409);
    expect((await testEnv.DB.prepare(`SELECT state,read_lease_token FROM photo_export_deliveries WHERE export_job_id=?`).bind(job.id).first<any>())).toMatchObject({ state: 'failed', read_lease_token: null });
  });
  it('fails the response stream when the completion receipt cannot be persisted', async () => {
    const job = await create(); await post(`/${job.id}/confirm`);
    const file = await createApp().request(`${base}/${job.id}/entries/${media.id}/file`, { headers: { cookie: access.manager.cookie } }, testEnv);
    const release = vi.spyOn(PhotoExportsRepository.prototype, 'releaseRead').mockRejectedValueOnce(new Error('Receipt write unavailable'));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        file.arrayBuffer().then(() => 'complete', () => 'failed'),
        new Promise<string>(resolve => { timeout = setTimeout(() => resolve('stalled'), 250); }),
      ]);
      expect(result).toBe('failed');
    } finally { clearTimeout(timeout); release.mockRestore(); }
  });
  it('dispatches only confirmed archives and observes ambiguous deterministic Workflow creation', async () => {
    const calls: string[] = [];
    const workflow = { createBatch: vi.fn(async (items: Array<{ id: string }>) => { calls.push(items[0]!.id); throw new Error('lost response'); }),
      get: vi.fn(async () => ({ status: async () => ({ status: 'queued' }) })) };
    const fixture = Object.create(testEnv) as typeof testEnv;
    Object.defineProperty(fixture, 'EXPORT_WORKFLOW', { value: workflow });
    const job = await create('archive'); expect(calls).toEqual([]);
    const response = await post(`/${job.id}/confirm`, {}, fixture);
    expect(response.status).toBe(200); expect(calls).toEqual([job.id]); expect(workflow.get).toHaveBeenCalledWith(job.id);
    expect((await response.json<any>()).data.export).toMatchObject({ state: 'queued', confirmedAt: expect.any(String) });
    const legacy = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/retry`, { method: 'POST', headers: writeHeaders(access.manager), body: '{}' }, testEnv);
    expect(legacy.status).toBe(409);
  });
});

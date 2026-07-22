import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';

const testEnv = env as AppEnv & { TEST_MIGRATION_QUERIES: string };
const origin = env.APP_ORIGIN;

function cookiesFrom(response: Response) {
  const value = response.headers.get('set-cookie') ?? '';
  const session = /candidary_session=([^;,]+)/u.exec(value)?.[1];
  const csrf = /candidary_csrf=([^;,]+)/u.exec(value)?.[1];
  if (!session || !csrf) throw new Error(`Expected session and CSRF cookies, received: ${value}`);
  return { cookie: `candidary_session=${session}; candidary_csrf=${csrf}`, csrf };
}

async function guestAccess() {
  const created = await createApp().request('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Welcome.' }),
  }, testEnv);
  const body = await created.json<any>();
  const exchange = await createApp().request(new URL(body.data.guestLink).pathname, { redirect: 'manual' }, testEnv);
  return { ...cookiesFrom(exchange), event: body.data.event, manager: cookiesFrom(created) };
}

function writeHeaders(access: { cookie: string; csrf: string }) {
  return {
    'content-type': 'application/json',
    cookie: access.cookie,
    origin,
    'x-candidary-csrf': access.csrf,
  };
}

function png(width: number, height: number, size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, [{
    name: '0001_core.sql',
    queries: JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[],
  }]);
});

describe('upload initiation', () => {
  it('reserves quota and returns an object-specific content-type-bound PUT URL', async () => {
    const access = await guestAccess();
    const payload = {
      filename: 'our moment.png', mimeType: 'image/png', byteSize: 1024,
      idempotencyKey: 'upload-1', guestName: 'Avery', caption: 'From our table',
    };
    const first = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify(payload),
    }, testEnv);
    const firstBody = await first.json<any>();
    const second = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify(payload),
    }, testEnv);
    const secondBody = await second.json<any>();

    expect(first.status).toBe(201);
    expect(firstBody.data.media.objectKey).toMatch(new RegExp(`^events/${access.event.id}/media/`));
    expect(firstBody.data.media.objectKey).not.toContain('our moment');
    expect(firstBody.data.uploadUrl).toContain('X-Amz-Signature=');
    expect(firstBody.data.uploadUrl).toContain('X-Amz-Expires=600');
    expect(new URL(firstBody.data.uploadUrl).hostname).toBe('local.r2.cloudflarestorage.com');
    expect(secondBody.data.media.id).toBe(firstBody.data.media.id);
    expect((await env.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>()).reserved_media_count).toBe(1);
  });

  it('rejects unsupported and oversized files before reserving quota', async () => {
    const access = await guestAccess();
    const unsupported = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'clip.gif', mimeType: 'image/gif', byteSize: 100, idempotencyKey: 'bad-1' }),
    }, testEnv);
    const oversized = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'huge.jpg', mimeType: 'image/jpeg', byteSize: 10 * 1024 * 1024 + 1, idempotencyKey: 'bad-2' }),
    }, testEnv);

    expect((await unsupported.json<any>()).code).toBe('FILE_TYPE_UNSUPPORTED');
    expect((await oversized.json<any>()).code).toBe('FILE_TOO_LARGE');
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media').first<{ count: number }>())?.count).toBe(0);
  });
});

describe('upload finalization and private delivery', () => {
  it('verifies R2 metadata and image headers, then finalizes idempotently', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'moment.png', mimeType: 'image/png', byteSize: 128, idempotencyKey: 'final-1' }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    await env.MEDIA_BUCKET.put(reserved.objectKey, png(1600, 900), { httpMetadata: { contentType: 'image/png' } });

    const finalize = () => createApp().request(`/api/event/${access.event.slug}/uploads/${reserved.id}/finalize`, {
      method: 'POST', headers: writeHeaders(access), body: '{}',
    }, testEnv);
    const first = await finalize();
    const firstBody = await first.json<any>();
    const repeated = await finalize();

    expect(first.status).toBe(200);
    expect(firstBody.data.media).toMatchObject({ uploadState: 'stored', moderationStatus: 'pending', width: 1600, height: 900, byteSize: 64 });
    expect((await repeated.json<any>()).data.media.id).toBe(reserved.id);

    const ownContent = await createApp().request(`/api/media/${reserved.id}/content`, { headers: { cookie: access.cookie } }, testEnv);
    expect(ownContent.status).toBe(200);
    expect(ownContent.headers.get('cache-control')).toBe('private, no-store');
    expect((await ownContent.arrayBuffer()).byteLength).toBe(64);
  });

  it('deletes a malicious object larger than its declaration and releases the reservation', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'small.png', mimeType: 'image/png', byteSize: 32, idempotencyKey: 'final-bad' }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    await env.MEDIA_BUCKET.put(reserved.objectKey, png(20, 20, 64), { httpMetadata: { contentType: 'image/png' } });

    const finalized = await createApp().request(`/api/event/${access.event.slug}/uploads/${reserved.id}/finalize`, {
      method: 'POST', headers: writeHeaders(access), body: '{}',
    }, testEnv);
    expect(finalized.status).toBe(413);
    expect((await finalized.json<any>()).code).toBe('FILE_TOO_LARGE');
    expect(await env.MEDIA_BUCKET.head(reserved.objectKey)).toBeNull();
    expect((await env.DB.prepare('SELECT upload_state FROM media WHERE id = ?').bind(reserved.id).first<any>()).upload_state).toBe('failed');
    expect((await env.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>()).reserved_media_count).toBe(0);
  });

  it('denies another guest access to pending media and denies old URLs after rejection', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'private.png', mimeType: 'image/png', byteSize: 128, idempotencyKey: 'privacy-1' }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    await env.MEDIA_BUCKET.put(reserved.objectKey, png(400, 300), { httpMetadata: { contentType: 'image/png' } });
    await createApp().request(`/api/event/${access.event.slug}/uploads/${reserved.id}/finalize`, {
      method: 'POST', headers: writeHeaders(access), body: '{}',
    }, testEnv);

    const guestToken = await env.DB.prepare("SELECT id, secret_ciphertext FROM event_access_tokens WHERE role = 'guest'").first<any>();
    const guestSecret = await (await import('../../worker/security/crypto')).decryptGuestSecret(guestToken.secret_ciphertext, testEnv.GUEST_TOKEN_ENCRYPTION_KEY);
    const otherExchange = await createApp().request(`/join/${guestToken.id}.${guestSecret}`, { redirect: 'manual' }, testEnv);
    const other = cookiesFrom(otherExchange);
    const pending = await createApp().request(`/api/media/${reserved.id}/content`, { headers: { cookie: other.cookie } }, testEnv);
    expect(pending.status).toBe(403);

    await env.DB.prepare("UPDATE media SET moderation_status = 'rejected' WHERE id = ?").bind(reserved.id).run();
    const rejected = await createApp().request(`/api/media/${reserved.id}/content`, { headers: { cookie: access.cookie } }, testEnv);
    expect(rejected.status).toBe(403);
  });
});


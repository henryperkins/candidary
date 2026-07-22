import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';

import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';

export const testEnv = env as AppEnv & { TEST_MIGRATION_QUERIES: string };
export const origin = env.APP_ORIGIN;

export function cookiesFrom(response: Response) {
  const value = response.headers.get('set-cookie') ?? '';
  const session = /candidary_session=([^;,]+)/u.exec(value)?.[1];
  const csrf = /candidary_csrf=([^;,]+)/u.exec(value)?.[1];
  if (!session || !csrf) throw new Error(`Expected session and CSRF cookies, received: ${value}`);
  return { cookie: `candidary_session=${session}; candidary_csrf=${csrf}`, csrf };
}

export function writeHeaders(access: { cookie: string; csrf: string }) {
  return {
    'content-type': 'application/json',
    cookie: access.cookie,
    origin,
    'x-candidary-csrf': access.csrf,
  };
}

export function png(width = 800, height = 600, size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export async function resetDatabase() {
  await reset();
  await applyD1Migrations(env.DB, [{
    name: '0001_core.sql',
    queries: JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[],
  }]);
}

export async function eventAccess(name = 'Maya & Theo') {
  const created = await createApp().request('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ name, eventDate: '2026-09-19', welcomeMessage: 'Welcome.' }),
  }, testEnv);
  const body = await created.json<any>();
  const managerCookies = cookiesFrom(created);
  const guestExchange = await createApp().request(new URL(body.data.guestLink).pathname, { redirect: 'manual' }, testEnv);
  return {
    event: body.data.event,
    guestLink: body.data.guestLink as string,
    managementLink: body.data.managementLink as string,
    manager: { ...managerCookies, csrf: body.data.csrfToken as string },
    guest: cookiesFrom(guestExchange),
  };
}

export async function secondGuest(guestLink: string) {
  const exchange = await createApp().request(new URL(guestLink).pathname, { redirect: 'manual' }, testEnv);
  return cookiesFrom(exchange);
}

export async function uploadPending(
  access: Awaited<ReturnType<typeof eventAccess>>,
  key: string,
  caption: string | null = null,
) {
  const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
    method: 'POST', headers: writeHeaders(access.guest),
    body: JSON.stringify({
      filename: `${key}.png`, mimeType: 'image/png', byteSize: 128,
      idempotencyKey: key, guestName: 'Avery', caption,
    }),
  }, testEnv);
  const media = (await initiated.json<any>()).data.media;
  await env.MEDIA_BUCKET.put(media.objectKey, png(), { httpMetadata: { contentType: 'image/png' } });
  const finalized = await createApp().request(`/api/event/${access.event.slug}/uploads/${media.id}/finalize`, {
    method: 'POST', headers: writeHeaders(access.guest), body: '{}',
  }, testEnv);
  return (await finalized.json<any>()).data.media;
}


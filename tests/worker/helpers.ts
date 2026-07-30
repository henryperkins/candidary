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

// The printed credential lives in the URL fragment, which `new URL().pathname`
// deliberately excludes. Every caller has to send it in the POST body, exactly
// as the join shell does, or it is not testing the real exchange.
export async function exchangeEventEntry(eventLink: string) {
  return createApp().request('/api/entry/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ token: new URL(eventLink).hash.slice(1) }),
  }, testEnv);
}

/**
 * Sends a complete settings payload. Settings is one atomic write, so a caller
 * has to state every field; this fills in the current values and lets a test
 * name only what it is changing.
 */
export async function applySettings(
  access: { event: any; manager: { cookie: string; csrf: string } },
  patch: Record<string, unknown> = {},
) {
  return createApp().request(`/api/manage/events/${access.event.id}/settings`, {
    method: 'PATCH',
    headers: writeHeaders(access.manager),
    body: JSON.stringify({
      uploadsEnabled: access.event.uploadsEnabled,
      galleryVisible: access.event.galleryVisible,
      moderationRequired: access.event.moderationRequired,
      eventTimezone: access.event.eventTimezone,
      rsvpDeadlineDate: access.event.rsvpDeadlineDate,
      rsvpEnabled: access.event.rsvpEnabled,
      rsvpRosterVersion: access.event.rsvpRosterVersion,
      ...patch,
    }),
  }, testEnv);
}

// New events open nothing. The photo-journey fixtures all assume intake is
// running, so this turns it on the way a host would rather than by writing to
// the database behind the route that owns the decision.
export async function eventAccess(name = 'Maya & Theo', uploadsEnabled = true) {
  const created = await createApp().request('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      name, eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
      eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05',
    }),
  }, testEnv);
  const body = await created.json<any>();
  const managerCookies = cookiesFrom(created);
  const guestExchange = await exchangeEventEntry(body.data.eventLink);
  const access = {
    event: body.data.event,
    eventLink: body.data.eventLink as string,
    managementLink: body.data.managementLink as string,
    manager: { ...managerCookies, csrf: body.data.csrfToken as string },
    guest: cookiesFrom(guestExchange),
  };

  if (!uploadsEnabled) return access;
  const opened = await applySettings(access, { uploadsEnabled: true });
  access.event = (await opened.json<any>()).data.event;
  return access;
}

export async function secondGuest(eventLink: string) {
  return cookiesFrom(await exchangeEventEntry(eventLink));
}

export async function uploadPending(
  access: Awaited<ReturnType<typeof eventAccess>>,
  key: string,
  caption: string | null = null,
  guestName = 'Avery',
) {
  const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
    method: 'POST', headers: writeHeaders(access.guest),
    body: JSON.stringify({
      filename: `${key}.png`, mimeType: 'image/png', byteSize: 128,
      idempotencyKey: key, guestName, caption,
    }),
  }, testEnv);
  const media = (await initiated.json<any>()).data.media;
  await env.MEDIA_BUCKET.put(media.objectKey, png(), { httpMetadata: { contentType: 'image/png' } });
  const finalized = await createApp().request(`/api/event/${access.event.slug}/uploads/${media.id}/finalize`, {
    method: 'POST', headers: writeHeaders(access.guest), body: '{}',
  }, testEnv);
  return (await finalized.json<any>()).data.media;
}

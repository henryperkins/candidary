import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { cookiesFrom, eventAccess, origin, resetDatabase, testEnv, writeHeaders } from './helpers';

function exchangeEntry(token: string) {
  return createApp().request('/api/entry/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ token }),
  }, testEnv);
}

function entryFragment(eventLink: string): string {
  return new URL(eventLink).hash.slice(1);
}

beforeEach(resetDatabase);

describe('durable event entry', () => {
  it('exchanges the printed fragment for an ordinary guest session', async () => {
    const access = await eventAccess();
    const link = new URL(access.eventLink);

    expect(link.pathname).toBe('/join');
    // The credential lives only in the fragment, which browsers do not put in a
    // request line or a referrer.
    expect(link.search).toBe('');
    expect(link.hash.slice(1)).toMatch(/^[\w-]+\.[\w-]+$/u);

    const exchanged = await exchangeEntry(entryFragment(access.eventLink));
    const body = await exchanged.json<any>();

    expect(exchanged.status).toBe(200);
    expect(body.data.location).toBe(`/event/${access.event.slug}`);
    expect(body.data.location).not.toContain('.');
    expect(JSON.stringify(body)).not.toContain(link.hash.slice(1));
    expect(() => cookiesFrom(exchanged)).not.toThrow();
  });

  it('keeps the printed link byte-identical across internal guest rotation', async () => {
    const access = await eventAccess();
    const before = access.eventLink;

    const rotated = await createApp().request(
      `/api/manage/events/${access.event.id}/guest-sessions/rotate`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );
    const rotatedBody = await rotated.json<any>();

    expect(rotated.status).toBe(200);
    expect(rotatedBody.data.rotated).toBe(true);
    // The whole promise of the printed QR: rotation changes who is signed in,
    // never what is on the sign.
    expect(rotatedBody.data.eventLink).toBe(before);

    const recovered = await createApp().request(
      `/api/manage/events/${access.event.id}/entry`,
      { headers: { cookie: access.manager.cookie, origin } },
      testEnv,
    );
    expect((await recovered.json<any>()).data.eventLink).toBe(before);

    // And it still opens.
    const reopened = await exchangeEntry(entryFragment(before));
    expect(reopened.status).toBe(200);
  });

  it('signs existing guest devices out when the internal grant rotates', async () => {
    const access = await eventAccess();

    await createApp().request(
      `/api/manage/events/${access.event.id}/guest-sessions/rotate`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );

    const stale = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: access.guest.cookie, origin },
    }, testEnv);
    expect(stale.status).toBe(401);
    expect((await stale.json<any>()).code).toBe('TOKEN_REVOKED');
  });

  it('refuses rotation without the exact event name', async () => {
    const access = await eventAccess();

    const refused = await createApp().request(
      `/api/manage/events/${access.event.id}/guest-sessions/rotate`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: 'Maya and Theo' }),
      },
      testEnv,
    );

    expect(refused.status).toBe(422);
    const stillWorks = await exchangeEntry(entryFragment(access.eventLink));
    expect(stillWorks.status).toBe(200);
  });

  it('ends the entry irreversibly, taking RSVP, uploads, and every guest with it', async () => {
    const access = await eventAccess();
    await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({
        uploadsEnabled: true, galleryVisible: true, moderationRequired: false,
        eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05',
        rsvpEnabled: false, rsvpRosterVersion: 0,
      }),
    }, testEnv);

    const disabled = await createApp().request(
      `/api/manage/events/${access.event.id}/entry/disable`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );
    const disabledBody = await disabled.json<any>();

    expect(disabled.status).toBe(200);
    expect(disabledBody.data.disabledAt).toEqual(expect.any(String));

    // Future scans stop.
    const refused = await exchangeEntry(entryFragment(access.eventLink));
    expect(refused.status).toBe(410);
    expect((await refused.json<any>()).code).toBe('EVENT_ENTRY_UNAVAILABLE');

    // Devices already holding a session stop too.
    const stale = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: access.guest.cookie, origin },
    }, testEnv);
    expect(stale.status).toBe(401);

    // Intake is paused rather than left quietly accepting bytes.
    const row = await env.DB.prepare(
      'SELECT uploads_enabled, rsvp_enabled FROM events WHERE id = ?',
    ).bind(access.event.id).first();
    expect(row).toEqual({ uploads_enabled: 0, rsvp_enabled: 0 });

    // The manager keeps working: this is an emergency stop for guests, not a
    // way to lock the host out of their own event.
    const managerStillWorks = await createApp().request(
      `/api/manage/events/${access.event.id}`,
      { headers: { cookie: access.manager.cookie, origin } },
      testEnv,
    );
    expect(managerStillWorks.status).toBe(200);
  });

  it('reports the same disabled state when the host confirms twice', async () => {
    const access = await eventAccess();
    const disable = () => createApp().request(
      `/api/manage/events/${access.event.id}/entry/disable`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );

    const first = await (await disable()).json<any>();
    const second = await (await disable()).json<any>();

    expect(second.data.disabledAt).toBe(first.data.disabledAt);
  });

  it('will not let rotation or settings reopen a disabled entry', async () => {
    const access = await eventAccess();
    await createApp().request(
      `/api/manage/events/${access.event.id}/entry/disable`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );

    const rotated = await createApp().request(
      `/api/manage/events/${access.event.id}/guest-sessions/rotate`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );
    expect(rotated.status).toBe(410);
    expect((await rotated.json<any>()).code).toBe('EVENT_ENTRY_UNAVAILABLE');

    const reopened = await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({
        uploadsEnabled: true, galleryVisible: true, moderationRequired: false,
        eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05',
        rsvpEnabled: false, rsvpRosterVersion: 0,
      }),
    }, testEnv);
    expect(reopened.status).toBe(410);
    expect((await reopened.json<any>()).code).toBe('EVENT_ENTRY_UNAVAILABLE');

    // Recovery stops offering a link it can no longer honour.
    const recovered = await createApp().request(
      `/api/manage/events/${access.event.id}/entry`,
      { headers: { cookie: access.manager.cookie, origin } },
      testEnv,
    );
    expect((await recovered.json<any>()).data).toMatchObject({
      eventLink: null,
      disabledAt: expect.any(String),
    });
  });

  it('refuses a malformed, unknown, or foreign fragment the same way', async () => {
    const access = await eventAccess();
    const other = await eventAccess('Other Event');

    for (const token of ['', 'no-dot', 'a.b.c', 'unknown-id.unknown-secret']) {
      const refused = await exchangeEntry(token);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(await refused.text()).not.toContain(entryFragment(access.eventLink));
    }

    // A correct id with the wrong secret must not be distinguishable from an
    // unknown id.
    const [id] = entryFragment(access.eventLink).split('.');
    const wrongSecret = await exchangeEntry(`${id}.${entryFragment(other.eventLink).split('.')[1]}`);
    expect(wrongSecret.status).toBe(410);
    expect((await wrongSecret.json<any>()).code).toBe('EVENT_ENTRY_UNAVAILABLE');
  });

  it('rejects an exchange from another origin', async () => {
    const access = await eventAccess();

    const refused = await createApp().request('/api/entry/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
      body: JSON.stringify({ token: entryFragment(access.eventLink) }),
    }, testEnv);

    expect(refused.status).toBe(403);
  });

  it('refuses an internal guest grant that has already expired', async () => {
    const access = await eventAccess();
    // getActiveForRole filters on revoked_at alone; only an explicit expiry
    // check stops a lapsed grant from minting a fresh session here.
    await env.DB.prepare(`
      UPDATE event_access_tokens SET expires_at = ? WHERE event_id = ? AND role = 'guest'
    `).bind('2020-01-01T00:00:00.000Z', access.event.id).run();

    const refused = await exchangeEntry(entryFragment(access.eventLink));

    expect(refused.status).toBe(410);
    expect((await refused.json<any>()).code).toBe('EVENT_EXPIRED');
  });

  it('never accepts the old tokenized join path', async () => {
    const access = await eventAccess();
    const legacy = await createApp().request(
      `/join/${entryFragment(access.eventLink)}`,
      { redirect: 'manual', headers: { accept: 'text/html' } },
      testEnv,
    );

    expect(legacy.status).toBe(302);
    const location = legacy.headers.get('location') ?? '';
    expect(location).toBe('/recover/event-entry?kind=unavailable');
    expect(location).not.toContain(entryFragment(access.eventLink));
  });

  it('stores the entry secret only as a digest and as ciphertext', async () => {
    const access = await eventAccess();
    const secret = entryFragment(access.eventLink).split('.')[1]!;

    const row = await env.DB.prepare(
      'SELECT secret_digest, secret_ciphertext FROM event_entry_credentials WHERE event_id = ?',
    ).bind(access.event.id).first<{ secret_digest: string; secret_ciphertext: string }>();

    expect(row?.secret_digest).not.toBe(secret);
    expect(row?.secret_ciphertext).not.toBe(secret);
    expect(row?.secret_ciphertext).not.toContain(secret);
    expect(row?.secret_ciphertext.startsWith('v1.')).toBe(true);
  });

  it('answers exchange failures with no-store and a safe referrer policy', async () => {
    const access = await eventAccess();

    const succeeded = await exchangeEntry(entryFragment(access.eventLink));
    const failed = await exchangeEntry('unknown-id.unknown-secret');

    for (const response of [succeeded, failed]) {
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('leaves the manager link exchange on its own path', async () => {
    const access = await eventAccess();
    const managerExchange = await createApp().request(
      new URL(access.managementLink).pathname,
      { redirect: 'manual' },
      testEnv,
    );

    expect(managerExchange.status).toBe(302);
    expect(managerExchange.headers.get('location'))
      .toBe(`/manage/event/${access.event.id}`);
  });
});

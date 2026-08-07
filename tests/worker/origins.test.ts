import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { applicationOrigins, canonicalOrigin, isApplicationOrigin, requestOrigin } from '../../worker/origins';
import { unsubscribeUrl } from '../../worker/services/notifications';
import { cookiesFrom, exchangeEventEntry, origin, resetDatabase, testEnv } from './helpers';

// `origin` is the canonical `APP_ORIGIN`; these two come from `ALTERNATE_ORIGINS`
// in `vitest.worker.config.ts`, so the suite runs against a deployment that
// answers on more than one hostname rather than one that happens to have a
// single front door.
const ALTERNATE = 'https://candidary.test';
const UNKNOWN = 'https://someone-elses-hostname.example';

function linkParts(link: string) {
  const url = new URL(link);
  return { origin: url.origin, path: url.pathname, hasFragment: url.hash.length > 1 };
}

function createEvent(from: string, name = 'Maya & Theo') {
  return createApp().request(`${from}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: from },
    body: JSON.stringify({
      name, eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
      eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05',
    }),
  }, testEnv);
}

describe('the origins a deployment answers on', () => {
  it('lists the canonical origin first, then the alternates', () => {
    expect(canonicalOrigin(testEnv)).toBe(origin);
    expect(applicationOrigins(testEnv)[0]).toBe(origin);
    expect(applicationOrigins(testEnv)).toContain(ALTERNATE);
  });

  it('recognizes every configured origin and refuses everything else', () => {
    for (const value of applicationOrigins(testEnv)) {
      expect(isApplicationOrigin(testEnv, value)).toBe(true);
      expect(isApplicationOrigin(testEnv, `${value}/`)).toBe(true);
    }
    expect(isApplicationOrigin(testEnv, UNKNOWN)).toBe(false);
    expect(isApplicationOrigin(testEnv, `${ALTERNATE}.evil.example`)).toBe(false);
    expect(isApplicationOrigin(testEnv, undefined)).toBe(false);
  });

  // A hostname someone else points at this Worker renders the SPA — nothing can
  // stop that — but it must never mint a link that appears to be Candidary's.
  it('falls back to the canonical origin for a host it does not answer on', () => {
    const context = {
      req: { url: `${UNKNOWN}/api/events` },
      env: testEnv,
    } as unknown as Parameters<typeof requestOrigin>[0];
    expect(requestOrigin(context)).toBe(origin);
  });
});

describe('writes from a second front door', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('accepts a write whose Origin is an alternate application origin', async () => {
    const response = await createEvent(ALTERNATE);
    expect(response.status).toBe(201);
  });

  it('refuses a write from a hostname the deployment does not answer on', async () => {
    const response = await createApp().request(`${ALTERNATE}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: UNKNOWN },
      body: JSON.stringify({
        name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
        eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05',
      }),
    }, testEnv);
    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('ORIGIN_FORBIDDEN');
  });

  it('still refuses a write that sends no Origin at all', async () => {
    const response = await createApp().request(`${ALTERNATE}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
        eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05',
      }),
    }, testEnv);
    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('ORIGIN_FORBIDDEN');
  });
});

describe('links minted while answering on a second origin', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('carries the hostname the host is actually working on', async () => {
    const body = await (await createEvent(ALTERNATE)).json<any>();
    expect(linkParts(body.data.eventLink)).toEqual({ origin: ALTERNATE, path: '/join', hasFragment: true });
    expect(linkParts(body.data.managementLink).origin).toBe(ALTERNATE);
    expect(linkParts(body.data.managementLink).path).toMatch(/^\/manage\/[^/]+$/u);
  });

  it('re-displays and rotates on that hostname too', async () => {
    const created = await createEvent(ALTERNATE);
    const body = await created.json<any>();
    const manager = { ...cookiesFrom(created), csrf: body.data.csrfToken as string };
    const write = {
      'content-type': 'application/json',
      cookie: manager.cookie,
      origin: ALTERNATE,
      'x-candidary-csrf': manager.csrf,
    };

    const recovered = await createApp().request(
      `${ALTERNATE}/api/manage/events/${body.data.event.id}/entry`,
      { headers: { cookie: manager.cookie } },
      testEnv,
    );
    expect(linkParts((await recovered.json<any>()).data.eventLink))
      .toEqual({ origin: ALTERNATE, path: '/join', hasFragment: true });

    // Rotation is refused while an ownerless event still has a live creator
    // recovery path, so the fixture gives it the durable owner that unblocks it.
    await env.DB.prepare(`
      INSERT INTO host_accounts (id, email, password_hash, created_at)
      VALUES ('owner-origins', 'owner-origins@example.com', 'password-hash', '2026-07-28T00:00:00.000Z')
    `).run();
    await env.DB.prepare(`
      INSERT INTO event_hosts (event_id, account_id, role, created_at)
      VALUES (?, 'owner-origins', 'owner', '2026-07-28T00:00:00.000Z')
    `).bind(body.data.event.id).run();

    // The management link is followed by a full-page navigation the moment it
    // comes back, so an origin that disagreed with the page would move the host
    // to the other domain mid-session.
    const rotated = await createApp().request(
      `${ALTERNATE}/api/manage/events/${body.data.event.id}/links/manager/rotate`,
      { method: 'POST', headers: write, body: '{}' },
      testEnv,
    );
    expect(linkParts((await rotated.json<any>()).data.managementLink).origin).toBe(ALTERNATE);
  });

  // Origin decides display, never authority. One credential, one row, and it
  // opens on whichever front door the guest reaches.
  it('mints a credential that resolves on either origin', async () => {
    const body = await (await createEvent(ALTERNATE)).json<any>();
    const exchanged = await exchangeEventEntry(body.data.eventLink);
    expect(exchanged.status).toBe(200);
    expect(cookiesFrom(exchanged).cookie).toContain('candidary_session=');
  });

  it('leaves mail on the canonical origin, where the From domain is', async () => {
    // Composed by the hourly Cron, where there is no request to take a host from,
    // and read in an inbox where a link on a different domain than the sender
    // reads as phishing.
    const unsubscribe = linkParts(await unsubscribeUrl(testEnv, 'account-id'));
    expect(unsubscribe.origin).toBe(origin);
    expect(unsubscribe.path).toMatch(/^\/host\/unsubscribe\/account-id\./u);
  });
});

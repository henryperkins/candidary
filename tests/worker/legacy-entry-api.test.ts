import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../worker/app';
import { EventEntriesRepository } from '../../worker/db/event-entries';
import { TokensRepository } from '../../worker/db/tokens';
import { eventAccess, origin, resetDatabase, testEnv, writeHeaders } from './helpers';

type Access = Awaited<ReturnType<typeof eventAccess>>;

/**
 * Rewinds an event to the shape it had before migration 0008: its guest access
 * token exists and is printed on invitations as `/join/<id>.<secret>`, and it has
 * no entry credential at all. That is exactly the state a live event is left in
 * by a deploy that performs no backfill.
 */
async function asLegacyEvent(access: Access) {
  const entries = new EventEntriesRepository(testEnv.DB);
  const entry = await entries.getForEvent(access.event.id);
  if (!entry) throw new Error('Expected the fixture event to have an entry credential.');
  await testEnv.DB.prepare('DELETE FROM event_entry_credentials WHERE event_id = ?')
    .bind(access.event.id).run();

  const token = await new TokensRepository(testEnv.DB).getActiveForRole(access.event.id, 'guest');
  if (!token?.secretCiphertext) throw new Error('Expected a recoverable guest grant.');
  const { decryptSecret } = await import('../../worker/security/crypto');
  const secret = await decryptSecret(token.secretCiphertext, testEnv.GUEST_TOKEN_ENCRYPTION_KEY);
  // The exact string the old QR encodes.
  return `${token.id}.${secret}`;
}

function scanPrinted(printed: string) {
  return createApp().request(`/join/${printed}`, { redirect: 'manual' }, testEnv);
}

beforeEach(resetDatabase);

describe('printed entry codes from before the RSVP migration', () => {
  it('opens the event and adopts the printed token as the entry credential', async () => {
    const access = await eventAccess();
    const printed = await asLegacyEvent(access);

    const scanned = await scanPrinted(printed);

    expect(scanned.status).toBe(302);
    expect(scanned.headers.get('location')).toBe(`/event/${access.event.slug}`);
    expect(scanned.headers.get('cache-control')).toBe('no-store');
    const cookie = scanned.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('candidary_session=');
    expect(cookie).toContain('candidary_csrf=');

    // The credential now exists under the id the printed code carries, so the
    // manager can redisplay exactly the link already in the world.
    const entry = await new EventEntriesRepository(testEnv.DB).getForEvent(access.event.id);
    expect(entry?.id).toBe(printed.split('.')[0]);
    const recovered = await createApp().request(
      `/api/manage/events/${access.event.id}/entry`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expect((await recovered.json<any>()).data.eventLink).toBe(`${origin}/join#${printed}`);
  });

  it('keeps the printed code working after guest devices are signed out', async () => {
    const access = await eventAccess();
    const printed = await asLegacyEvent(access);
    expect((await scanPrinted(printed)).status).toBe(302);

    // The whole reason the printed token is copied into its own row rather than
    // pointed at: rotation replaces the internal grant and must not reach it.
    const rotated = await createApp().request(
      `/api/manage/events/${access.event.id}/guest-sessions/rotate`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );
    expect(rotated.status).toBe(200);
    expect((await rotated.json<any>()).data.eventLink).toBe(`${origin}/join#${printed}`);

    const rescanned = await scanPrinted(printed);
    expect(rescanned.status).toBe(302);
    expect(rescanned.headers.get('location')).toBe(`/event/${access.event.slug}`);
    expect(rescanned.headers.get('set-cookie') ?? '').toContain('candidary_session=');
  });

  it('serves the same credential whether it is scanned as a path or a fragment', async () => {
    const access = await eventAccess();
    const printed = await asLegacyEvent(access);
    await scanPrinted(printed);

    const exchanged = await createApp().request('/api/entry/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ token: printed }),
    }, testEnv);

    expect(exchanged.status).toBe(200);
    expect((await exchanged.json<any>()).data.location).toBe(`/event/${access.event.slug}`);
  });

  it('keeps a delayed legacy adoption from reopening a concurrently disabled entry', async () => {
    const access = await eventAccess();
    const printed = await asLegacyEvent(access);
    let enteredDecrypt!: () => void;
    let releaseDecrypt!: () => void;
    const decryptEntered = new Promise<void>((resolve) => { enteredDecrypt = resolve; });
    const decryptReleased = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
    const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (
      algorithm,
      key,
      data,
    ) => {
      enteredDecrypt();
      await decryptReleased;
      return realDecrypt(algorithm, key, data);
    });

    try {
      // The scan has read the still-active token and is now paused in the async
      // crypto work that used to separate that read from an unconditional insert.
      const delayedScan = scanPrinted(printed);
      await decryptEntered;

      const disabled = await createApp().request(
        `/api/manage/events/${access.event.id}/entry/disable`,
        {
          method: 'POST',
          headers: writeHeaders(access.manager),
          body: JSON.stringify({ confirmName: access.event.name }),
        },
        testEnv,
      );

      releaseDecrypt();
      const scanned = await delayedScan;
      const entry = await new EventEntriesRepository(testEnv.DB).getForEvent(access.event.id);

      expect(disabled.status).toBe(200);
      expect(entry?.disabledAt).toEqual(expect.any(String));
      expect(scanned.headers.get('location')).toBe('/recover/event-entry?kind=unavailable');
      expect(scanned.headers.get('set-cookie')).toBeNull();

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
    } finally {
      releaseDecrypt();
      decryptSpy.mockRestore();
    }
  });

  it('stops with the entry, and never adopts on a wrong or revoked secret', async () => {
    const access = await eventAccess();
    const printed = await asLegacyEvent(access);
    const [id, secret] = printed.split('.');

    // A wrong secret writes nothing, so an unauthenticated scan cannot conjure a
    // credential for an event it does not already hold access to.
    const forged = await scanPrinted(`${id}.${'x'.repeat(secret!.length)}`);
    expect(forged.headers.get('location')).toBe('/recover/event-entry?kind=unavailable');
    expect(await new EventEntriesRepository(testEnv.DB).getForEvent(access.event.id)).toBeNull();

    expect((await scanPrinted(printed)).status).toBe(302);
    const disabled = await createApp().request(
      `/api/manage/events/${access.event.id}/entry/disable`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );
    expect(disabled.status).toBe(200);

    const afterDisable = await scanPrinted(printed);
    expect(afterDisable.headers.get('location')).toBe('/recover/event-entry?kind=unavailable');
    expect(afterDisable.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a malformed scan on the same token-free page', async () => {
    const scanned = await scanPrinted('not-a-real-credential');
    expect(scanned.status).toBe(302);
    expect(scanned.headers.get('location')).toBe('/recover/event-entry?kind=unavailable');
    expect(scanned.headers.get('set-cookie')).toBeNull();
  });
});

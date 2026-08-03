import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import {
  applySettings,
  eventAccess,
  importRoster,
  openRsvp,
  origin,
  resetDatabase,
  testEnv,
  writeHeaders,
} from './helpers';

type Access = Awaited<ReturnType<typeof eventAccess>>;

const ROSTER = [
  'household_key,household_label,invitee_name,plus_one_slots',
  'perkins,Perkins household,Henry Perkins,1',
  'perkins,Perkins household,Jordan Perkins,1',
  'rivera,Rivera household,Avery Rivera,0',
  'lee-a,Lee household,Alex Lee,0',
  'lee-a,Lee household,Sam Lee,0',
  'lee-b,Lee household,Alex Lee,0',
  'lee-b,Lee household,Pat Lee,0',
].join('\n');

function lookup(
  access: Access,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return createApp().request(`/api/event/${access.event.slug}/rsvp/lookup`, {
    method: 'POST',
    headers: { ...writeHeaders(access.guest), 'cf-connecting-ip': '203.0.113.10', ...headers },
    body: JSON.stringify(body),
  }, testEnv);
}

function rsvpCookiesFrom(response: Response) {
  const value = response.headers.get('set-cookie') ?? '';
  const session = /candidary_rsvp=([^;,]+)/u.exec(value)?.[1];
  const csrf = /candidary_rsvp_csrf=([^;,]+)/u.exec(value)?.[1];
  if (!session || !csrf) throw new Error(`Expected RSVP cookies, received: ${value}`);
  return { cookie: `candidary_rsvp=${session}; candidary_rsvp_csrf=${csrf}`, csrf };
}

function household(access: Access, cookie: string) {
  return createApp().request(`/api/event/${access.event.slug}/rsvp/household`, {
    headers: { cookie, origin },
  }, testEnv);
}

async function ready(name = 'Maya & Theo') {
  const access = await eventAccess(name);
  await importRoster(access, ROSTER);
  await openRsvp(access);
  return access;
}

/**
 * Closes the deadline and leaves the event ahead of its own start: the window
 * where a household may still read the response it already sent.
 *
 * Both boundaries are single server-owned instants, so the only way to test
 * either side of one is to move it.
 */
async function readOnlyWindow(access: Access) {
  await env.DB.prepare('UPDATE events SET rsvp_deadline_at = ? WHERE id = ?')
    .bind('2020-01-01T00:00:00.000Z', access.event.id).run();
}

async function startTheEvent(access: Access) {
  await env.DB.prepare('UPDATE events SET event_start_at = ? WHERE id = ?')
    .bind('2020-01-01T00:00:00.000Z', access.event.id).run();
}

async function respond(householdKey: string) {
  await env.DB.prepare(`
    UPDATE rsvp_households
    SET first_responded_at = ?, latest_responded_at = ?, latest_actor_kind = 'household'
    WHERE household_key = ?
  `).bind('2026-07-21T12:00:00.000Z', '2026-07-21T12:00:00.000Z', householdKey).run();
}

beforeEach(resetDatabase);

describe('exact-name household lookup', () => {
  it('opens the household of a full exact match', async () => {
    const access = await ready();
    const response = await lookup(access, { firstName: 'Henry Perkins' });
    const body = await response.json<any>();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe('matched');
    expect(body.data.household).toMatchObject({
      label: 'Perkins household',
      version: 1,
      editable: true,
      renewalRequired: false,
    });
    expect(body.data.household.invitees.map((row: any) => [row.kind, row.displayName])).toEqual([
      ['named', 'Henry Perkins'],
      ['named', 'Jordan Perkins'],
      ['plus_one', null],
    ]);
    // The household view carries nothing that identifies the roster itself.
    expect(body.data.household).not.toHaveProperty('householdKey');
    expect(JSON.stringify(body)).not.toContain('Rivera');
    expect(() => rsvpCookiesFrom(response)).not.toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ['a partial name', { firstName: 'Henry' }],
    ['a surname alone', { firstName: 'Perkins' }],
    ['a diacritic-folded name', { firstName: 'Hénry Perkins' }],
    ['a plus-one slot', { firstName: 'Plus One' }],
    ['somebody who was never invited', { firstName: 'Nobody At All' }],
  ])('answers the same generic refusal for %s', async (_label, body) => {
    const access = await ready();
    const response = await lookup(access, body);
    const parsed = await response.json<any>();

    expect(response.status).toBe(200);
    expect(parsed.data).toEqual({
      status: 'not_available',
      message: expect.any(String),
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  // `second_name_required` is a fact about the live roster: it says the name is
  // on the list twice. While RSVP is not open a household that never answered is
  // already invisible, so an ambiguous name must be too — otherwise a stranger
  // who cannot open anything can still confirm a name.
  it.each<[string, Record<string, unknown>]>([
    ['paused', { rsvpEnabled: false }],
    ['closed', { rsvpDeadlineDate: '2020-01-01' }],
  ])('hides an ambiguous name behind the generic refusal while RSVP is %s', async (_label, patch) => {
    const access = await ready();
    const current = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    access.event = (await current.json<any>()).data.event;
    const changed = await applySettings(access, { rsvpEnabled: false, ...patch });
    expect(changed.status).toBe(200);

    const response = await lookup(access, { firstName: 'Alex Lee' });
    expect((await response.json<any>()).data).toEqual({
      status: 'not_available',
      message: expect.any(String),
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a name from another event', async () => {
    const access = await ready();
    const other = await eventAccess('Other Event');
    await importRoster(other, 'household_key,household_label,invitee_name,plus_one_slots\nstone,Stone household,Robin Stone,0');
    await openRsvp(other);

    const response = await lookup(access, { firstName: 'Robin Stone' });
    expect((await response.json<any>()).data.status).toBe('not_available');
  });

  it('asks for a second name without naming a single candidate', async () => {
    const access = await ready();
    const response = await lookup(access, { firstName: 'Alex Lee' });
    const body = await response.json<any>();

    expect(body.data).toEqual({ status: 'second_name_required' });
    // Nothing here may hint at who else is in either household.
    const serialized = JSON.stringify(body);
    for (const name of ['Sam', 'Pat', 'Lee household', 'lee-a', 'lee-b']) {
      expect(serialized).not.toContain(name);
    }
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('resolves an ambiguous name by intersecting both names', async () => {
    const access = await ready();
    const response = await lookup(access, { firstName: 'Alex Lee', secondName: 'Sam Lee' });
    const body = await response.json<any>();

    expect(body.data.status).toBe('matched');
    expect(body.data.household.invitees.map((row: any) => row.displayName))
      .toEqual(['Alex Lee', 'Sam Lee']);
  });

  it('refuses a second name that does not narrow to one household', async () => {
    const access = await ready();
    const response = await lookup(access, { firstName: 'Alex Lee', secondName: 'Avery Rivera' });
    expect((await response.json<any>()).data.status).toBe('not_available');
  });

  it('refuses an archived household', async () => {
    const access = await ready();
    await env.DB.prepare(`
      UPDATE rsvp_households SET archived_at = ? WHERE household_key = 'rivera'
    `).bind('2026-07-21T12:00:00.000Z').run();

    const response = await lookup(access, { firstName: 'Avery Rivera' });
    expect((await response.json<any>()).data.status).toBe('not_available');
  });

  it('hides a household that never answered once RSVP closes', async () => {
    const access = await ready();
    await readOnlyWindow(access);

    const missed = await lookup(access, { firstName: 'Nobody At All' });
    const unanswered = await lookup(access, { firstName: 'Avery Rivera' });

    // An invited name with nothing saved behind it is indistinguishable from a
    // name that was never on the list, so the read-only window cannot be turned
    // into a roster-enumeration surface.
    expect((await unanswered.json<any>()).data).toEqual((await missed.json<any>()).data);
    expect(unanswered.headers.get('set-cookie')).toBeNull();
  });

  it('still opens a household that already answered once RSVP closes', async () => {
    const access = await ready();
    await respond('rivera');
    await readOnlyWindow(access);

    const response = await lookup(access, { firstName: 'Avery Rivera' });
    const body = await response.json<any>();

    expect(body.data.status).toBe('matched');
    // Readable, but past the deadline nobody may change it.
    expect(body.data.household.editable).toBe(false);
  });

  it('answers a lookup after the event starts exactly as it answers a miss', async () => {
    const access = await ready();
    // A household that has answered, so nothing but the start could be hiding
    // it: before the start this exact name opens the invitation.
    await respond('rivera');
    const missed = await lookup(access, { firstName: 'Nobody At All' });
    await startTheEvent(access);

    const started = await lookup(access, { firstName: 'Avery Rivera' });

    // One uniform refusal, so the boundary is not an oracle either.
    expect(started.status).toBe(missed.status);
    expect((await started.json<any>()).data).toEqual((await missed.json<any>()).data);
    expect(started.headers.get('set-cookie')).toBeNull();
  });

  it('refuses lookup entirely when RSVP was never configured', async () => {
    const access = await eventAccess('No Roster');
    const response = await lookup(access, { firstName: 'Henry Perkins' });
    expect((await response.json<any>()).data.status).toBe('not_available');
  });

  it('needs an event guest session, not just any credential', async () => {
    const access = await ready();

    const anonymous = await createApp().request(`/api/event/${access.event.slug}/rsvp/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ firstName: 'Henry Perkins' }),
    }, testEnv);
    expect(anonymous.status).toBe(401);

    const manager = await createApp().request(`/api/event/${access.event.slug}/rsvp/lookup`, {
      method: 'POST',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({ firstName: 'Henry Perkins' }),
    }, testEnv);
    expect(manager.status).toBe(403);
  });
});

describe('household session scope', () => {
  async function matched(access: Access) {
    const response = await lookup(access, { firstName: 'Henry Perkins' });
    return rsvpCookiesFrom(response);
  }

  it('reads its own household back on a returning device', async () => {
    const access = await ready();
    const rsvp = await matched(access);

    const response = await household(access, rsvp.cookie);
    const body = await response.json<any>();

    expect(response.status).toBe(200);
    expect(body.data.household).toMatchObject({ label: 'Perkins household', editable: true });
  });

  it('sends a missing or revoked household session back to lookup', async () => {
    const access = await ready();
    const rsvp = await matched(access);

    const anonymous = await household(access, '');
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json<any>()).code).toBe('RSVP_SESSION_REQUIRED');

    await env.DB.prepare('UPDATE rsvp_sessions SET revoked_at = ?')
      .bind('2026-07-21T12:00:00.000Z').run();
    const revoked = await household(access, rsvp.cookie);
    expect(revoked.status).toBe(401);
    expect((await revoked.json<any>()).code).toBe('RSVP_SESSION_REQUIRED');
  });

  it('cannot reach another event with a household cookie', async () => {
    const access = await ready();
    const rsvp = await matched(access);
    const other = await ready('Other Event');

    const response = await household(other, rsvp.cookie);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('lets the event, household, and host cookies coexist', async () => {
    const access = await ready();
    const rsvp = await matched(access);
    const combined = `${access.guest.cookie}; ${rsvp.cookie}`;

    const shell = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: combined },
    }, testEnv);
    const householdRead = await household(access, combined);

    expect(shell.status).toBe(200);
    expect(householdRead.status).toBe(200);
  });

  it('will not let an RSVP CSRF token authorize a photo upload', async () => {
    const access = await ready();
    const rsvp = await matched(access);

    const refused = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${access.guest.cookie}; ${rsvp.cookie}`,
        origin,
        'x-candidary-csrf': rsvp.csrf,
      },
      body: JSON.stringify({
        filename: 'a.png', mimeType: 'image/png', byteSize: 128,
        idempotencyKey: 'cross-scope', guestName: 'Avery',
      }),
    }, testEnv);

    expect(refused.status).toBe(403);
    expect((await refused.json<any>()).code).toBe('CSRF_INVALID');
  });

  it('reports that a lapsed write window needs a fresh lookup', async () => {
    const access = await ready();
    const rsvp = await matched(access);
    // The event is extended after this device proved who it was.
    await env.DB.prepare('UPDATE rsvp_sessions SET write_authority_deadline = ?')
      .bind('2020-01-01T00:00:00.000Z').run();

    const body = await (await household(access, rsvp.cookie)).json<any>();

    expect(body.data.household).toMatchObject({ editable: false, renewalRequired: true });
  });
});

describe('lookup abuse boundaries', () => {
  it('charges the IP once and each submitted name once', async () => {
    const access = await ready();
    await lookup(access, { firstName: 'Alex Lee', secondName: 'Sam Lee' });

    const rows = await env.DB.prepare(`
      SELECT action, COUNT(*) AS rows_for_action, SUM(attempts) AS attempts
      FROM rsvp_lookup_rate_limits GROUP BY action ORDER BY action
    `).all<{ action: string; rows_for_action: number; attempts: number }>();

    expect(rows.results).toEqual([
      { action: 'lookup_ip', rows_for_action: 1, attempts: 1 },
      { action: 'lookup_name', rows_for_action: 2, attempts: 2 },
    ]);
  });

  it('refuses generically past the durable per-address budget', async () => {
    const access = await ready();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const allowed = await lookup(access, { firstName: `Guess Number ${attempt}` });
      expect(allowed.status).toBe(200);
    }

    const refused = await lookup(access, { firstName: 'Henry Perkins' });

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('900');
    const body = await refused.json<any>();
    expect(body.code).toBe('RATE_LIMITED');
    // A refusal must not become an oracle for whether the name existed.
    expect(JSON.stringify(body)).not.toContain('Perkins');
  });

  it('refuses past the per-name budget without exhausting the address budget', async () => {
    const access = await ready();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const allowed = await lookup(
        access,
        { firstName: 'Henry Perkins' },
        { 'cf-connecting-ip': `203.0.113.${attempt}` },
      );
      expect(allowed.status).toBe(200);
    }

    const refused = await lookup(
      access,
      { firstName: 'Henry Perkins' },
      { 'cf-connecting-ip': '203.0.113.200' },
    );
    expect(refused.status).toBe(429);
  });

  it('stores no address and no name, only keyed digests', async () => {
    const access = await ready();
    await lookup(access, { firstName: 'Henry Perkins' });

    const rows = await env.DB.prepare('SELECT scope_digest FROM rsvp_lookup_rate_limits')
      .all<{ scope_digest: string }>();
    for (const row of rows.results) {
      expect(row.scope_digest).not.toContain('203.0.113');
      expect(row.scope_digest.toLowerCase()).not.toContain('perkins');
    }
  });

  it('ignores a spoofed forwarding header', async () => {
    const access = await ready();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await lookup(access, { firstName: `Guess Number ${attempt}` });
    }

    // A visitor cannot buy a fresh budget by inventing a forwarded address.
    const refused = await lookup(access, { firstName: 'Henry Perkins' }, {
      'x-forwarded-for': '198.51.100.7',
      forwarded: 'for=198.51.100.8',
    });
    expect(refused.status).toBe(429);
  });
});

// The window this design added is the one where a stranger has the least to
// lose by guessing: nothing here can be written, so nothing here refuses them
// for a reason a lookup would. Every boundary therefore has to hold exactly as
// it does while RSVP is open.
describe('lookup abuse boundaries in the read-only window', () => {
  async function readOnly(name = 'Maya & Theo') {
    const access = await ready(name);
    await readOnlyWindow(access);
    return access;
  }

  it('spends the edge budget before parsing a body or reading a session', async () => {
    const access = await readOnly();
    const charged: string[] = [];
    const exhaustedEdge = {
      ...testEnv,
      RSVP_LOOKUP_RATE_LIMIT: {
        limit: async (options: { key: string }) => {
          charged.push(options.key);
          return { success: false };
        },
      },
    };

    // No session at all, and a body no parser would accept. Neither is reached.
    // The edge budget's whole value is being cheap: a flood of guesses should
    // cost a key derivation and nothing else.
    const response = await createApp().request(`/api/event/${access.event.slug}/rsvp/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': '203.0.113.10' },
      body: 'not json at all',
    }, exhaustedEdge);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect((await response.json<any>()).code).toBe('RATE_LIMITED');
    expect(charged).toHaveLength(1);
    // The durable budgets sit behind the edge and were never charged.
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM rsvp_lookup_rate_limits')
      .first('count')).toBe(0);
  });

  it('charges the IP and every submitted name before reading the roster', async () => {
    const access = await readOnly();
    // Neither household can be opened in this window, so nothing but the order
    // of the work explains these rows.
    await lookup(access, { firstName: 'Alex Lee', secondName: 'Sam Lee' });

    const rows = await env.DB.prepare(`
      SELECT action, COUNT(*) AS rows_for_action, SUM(attempts) AS attempts
      FROM rsvp_lookup_rate_limits GROUP BY action ORDER BY action
    `).all<{ action: string; rows_for_action: number; attempts: number }>();

    expect(rows.results).toEqual([
      { action: 'lookup_ip', rows_for_action: 1, attempts: 1 },
      { action: 'lookup_name', rows_for_action: 2, attempts: 2 },
    ]);
  });

  it('still refuses past the durable per-address budget', async () => {
    const access = await readOnly();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const allowed = await lookup(access, { firstName: `Guess Number ${attempt}` });
      expect(allowed.status).toBe(200);
    }

    const refused = await lookup(access, { firstName: 'Henry Perkins' });

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('900');
    expect((await refused.json<any>()).code).toBe('RATE_LIMITED');
  });

  it('still refuses past the per-name budget without exhausting the address budget', async () => {
    const access = await readOnly();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const allowed = await lookup(
        access,
        { firstName: 'Henry Perkins' },
        { 'cf-connecting-ip': `203.0.113.${attempt}` },
      );
      expect(allowed.status).toBe(200);
    }

    const refused = await lookup(
      access,
      { firstName: 'Henry Perkins' },
      { 'cf-connecting-ip': '203.0.113.200' },
    );
    expect(refused.status).toBe(429);
  });
});

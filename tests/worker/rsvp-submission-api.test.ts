import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { RsvpAuthService } from '../../worker/auth/rsvp';
import { RsvpService } from '../../worker/services/rsvp';
import {
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
  // Two slots, so one submission can show an attending slot keeping its name
  // and a declined slot having one taken away.
  'perkins,Perkins household,Henry Perkins,2',
  'perkins,Perkins household,Jordan Perkins,2',
].join('\n');

interface Household {
  id: string;
  version: number;
  editable: boolean;
  deadlineAt: string;
  invitees: Array<{ id: string; kind: string; displayName: string | null; attendance: string }>;
}

interface Session {
  cookie: string;
  csrf: string;
  // The raw `id.secret`, kept so a test can resolve this household itself and
  // reach the service without the route in front of it.
  token: string;
  household: Household;
}

function rsvpHeaders(session: Session) {
  return {
    'content-type': 'application/json',
    cookie: session.cookie,
    origin,
    'x-candidary-rsvp-csrf': session.csrf,
  };
}

async function opened(name = 'Maya & Theo'): Promise<{ access: Access; session: Session }> {
  const access = await eventAccess(name);
  await importRoster(access, ROSTER);
  await openRsvp(access);

  const response = await createApp().request(`/api/event/${access.event.slug}/rsvp/lookup`, {
    method: 'POST',
    headers: { ...writeHeaders(access.guest), 'cf-connecting-ip': '203.0.113.10' },
    body: JSON.stringify({ firstName: 'Henry Perkins' }),
  }, testEnv);
  const value = response.headers.get('set-cookie') ?? '';
  const sessionCookie = /candidary_rsvp=([^;,]+)/u.exec(value)?.[1];
  const csrf = /candidary_rsvp_csrf=([^;,]+)/u.exec(value)?.[1];
  if (!sessionCookie || !csrf) throw new Error(`Expected RSVP cookies, received: ${value}`);

  return {
    access,
    session: {
      cookie: `candidary_rsvp=${sessionCookie}; candidary_rsvp_csrf=${csrf}`,
      csrf,
      token: sessionCookie,
      household: (await response.json<any>()).data.household,
    },
  };
}

function submit(access: Access, session: Session, body: Record<string, unknown>) {
  return createApp().request(`/api/event/${access.event.slug}/rsvp/household`, {
    method: 'PUT',
    headers: rsvpHeaders(session),
    body: JSON.stringify(body),
  }, testEnv);
}

function answers(
  household: Household,
  attendance: 'attending' | 'declined',
  plusOneName: string | null = null,
) {
  return household.invitees.map((invitee) => ({
    id: invitee.id,
    attendance,
    displayName: invitee.kind === 'plus_one' && attendance === 'attending' ? plusOneName : null,
  }));
}

async function storedAttendance(householdId: string) {
  const rows = await env.DB.prepare(`
    SELECT kind, display_name, attendance FROM rsvp_invitees
    WHERE household_id = ? ORDER BY sort_order
  `).bind(householdId).all<any>();
  return rows.results.map((row) => [row.kind, row.display_name, row.attendance]);
}

beforeEach(resetDatabase);

describe('household responses', () => {
  it('records a mixed answer and names the attending plus-one', async () => {
    const { access, session } = await opened();
    const { household } = session;

    const response = await submit(access, session, {
      version: household.version,
      idempotencyKey: 'submit-1',
      invitees: [
        { id: household.invitees[0]!.id, attendance: 'attending', displayName: null },
        { id: household.invitees[1]!.id, attendance: 'declined', displayName: null },
        { id: household.invitees[2]!.id, attendance: 'attending', displayName: 'Sam Rivera' },
        { id: household.invitees[3]!.id, attendance: 'declined', displayName: 'ignored' },
      ],
    });
    const body = await response.json<any>();

    expect(response.status).toBe(200);
    expect(body.data.committedVersion).toBe(2);
    expect(body.data.replayed).toBe(false);
    expect(await storedAttendance(household.id)).toEqual([
      ['named', 'Henry Perkins', 'attending'],
      ['named', 'Jordan Perkins', 'declined'],
      // An attending slot says who is coming; a declined one is cleared even
      // though the browser sent a name for it.
      ['plus_one', 'Sam Rivera', 'attending'],
      ['plus_one', null, 'declined'],
    ]);
  });

  it.each<['attending' | 'declined', string]>([
    ['attending', 'Sam Rivera'],
    ['declined', 'Sam Rivera'],
  ])('accepts an all-%s household', async (attendance, plusOneName) => {
    const { access, session } = await opened();
    const response = await submit(access, session, {
      version: session.household.version,
      idempotencyKey: `all-${attendance}`,
      invitees: answers(session.household, attendance, plusOneName),
    });

    expect(response.status).toBe(200);
    const stored = await storedAttendance(session.household.id);
    expect(stored.every((row) => row[2] === attendance)).toBe(true);
  });

  it('records who answered and when, once and then again', async () => {
    const { access, session } = await opened();
    await submit(access, session, {
      version: 1, idempotencyKey: 'first', invitees: answers(session.household, 'attending', 'Sam Rivera'),
    });
    const second = await submit(access, session, {
      version: 2, idempotencyKey: 'second', invitees: answers(session.household, 'declined'),
    });
    const body = await second.json<any>();

    expect(body.data.household.firstRespondedAt).toEqual(expect.any(String));
    expect(body.data.household.latestActor).toBe('household');
    // The first response time is the first one, not the latest.
    expect(Date.parse(body.data.household.latestRespondedAt))
      .toBeGreaterThanOrEqual(Date.parse(body.data.household.firstRespondedAt));
  });

  it.each<[string, (household: Household) => unknown[]]>([
    ['an omitted person', (h) => answers(h, 'attending', 'Sam').slice(1)],
    ['a repeated id', (h) => [
      ...answers(h, 'attending', 'Sam').slice(1),
      { id: h.invitees[1]!.id, attendance: 'declined', displayName: null },
    ]],
    ['an invented id', (h) => [
      ...answers(h, 'attending', 'Sam').slice(1),
      { id: '11111111-2222-4333-8444-555555555555', attendance: 'declined', displayName: null },
    ]],
  ])('refuses %s and writes nothing', async (_label, build) => {
    const { access, session } = await opened();
    const response = await submit(access, session, {
      version: session.household.version,
      idempotencyKey: 'partial',
      invitees: build(session.household),
    });

    expect(response.status).toBe(422);
    expect((await storedAttendance(session.household.id)).every((row) => row[2] === 'pending')).toBe(true);
  });

  it('refuses an attending plus-one with no name', async () => {
    const { access, session } = await opened();
    const response = await submit(access, session, {
      version: session.household.version,
      idempotencyKey: 'nameless-slot',
      invitees: answers(session.household, 'attending', null),
    });

    expect(response.status).toBe(422);
    expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['a name over 80 characters', 'x'.repeat(81)],
    ['a Unicode format character', 'Sam\u200cRivera'],
  ])('refuses an attending plus-one with %s', async (_label, displayName) => {
    const { access, session } = await opened();
    const response = await submit(access, session, {
      version: session.household.version,
      idempotencyKey: 'invalid-plus-one-name',
      invitees: answers(session.household, 'attending', displayName),
    });

    expect(response.status).toBe(422);
    expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
  });

  it('refuses pending choices and a household larger than the capacity limit', async () => {
    const { access, session } = await opened();
    const pending = await submit(access, session, {
      version: session.household.version,
      idempotencyKey: 'pending-choice',
      invitees: session.household.invitees.map((invitee) => ({
        id: invitee.id,
        attendance: 'pending',
        displayName: null,
      })),
    });
    expect(pending.status).toBe(422);

    const overflow = await submit(access, session, {
      version: session.household.version,
      idempotencyKey: 'capacity-overflow',
      invitees: Array.from({ length: 31 }, (_, index) => ({
        id: index === 0
          ? session.household.invitees[0]!.id
          : crypto.randomUUID(),
        attendance: 'declined',
        displayName: null,
      })),
    });
    expect(overflow.status).toBe(422);
  });
});

describe('deadlines and pauses', () => {
  it('accepts the exact deadline millisecond and refuses the next one', async () => {
    const { access, session } = await opened();
    const deadline = Date.parse(session.household.deadlineAt ?? access.event.rsvpDeadlineAt);
    expect(Number.isFinite(deadline)).toBe(true);

    await env.DB.prepare('UPDATE events SET rsvp_deadline_at = ? WHERE id = ?')
      .bind(new Date(deadline).toISOString(), access.event.id).run();
    // The guarded write compares against one server-owned instant, so the only
    // way to test the boundary is to move the boundary.
    const accepted = await submit(access, session, {
      version: 1, idempotencyKey: 'at-deadline', invitees: answers(session.household, 'declined'),
    });
    expect(accepted.status).toBe(200);

    await env.DB.prepare('UPDATE events SET rsvp_deadline_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', access.event.id).run();
    const refused = await submit(access, session, {
      version: 2, idempotencyKey: 'after-deadline', invitees: answers(session.household, 'attending', 'Sam'),
    });
    expect(refused.status).toBe(409);
    expect((await refused.json<any>()).code).toBe('RSVP_HOUSEHOLD_CONFLICT');
    const readOnly = await createApp().request(
      `/api/event/${access.event.slug}/rsvp/household`,
      { headers: { cookie: session.cookie } },
      testEnv,
    );
    expect(readOnly.status).toBe(200);
    expect((await readOnly.json<any>()).data.household.editable).toBe(false);
  });

  it('refuses a write while RSVP is paused', async () => {
    const { access, session } = await opened();
    await env.DB.prepare('UPDATE events SET rsvp_enabled = 0 WHERE id = ?')
      .bind(access.event.id).run();

    const refused = await submit(access, session, {
      version: 1, idempotencyKey: 'paused', invitees: answers(session.household, 'attending', 'Sam'),
    });

    expect(refused.status).toBe(409);
    expect((await storedAttendance(session.household.id)).every((row) => row[2] === 'pending')).toBe(true);
  });

  it('lets a shortened event deadline beat a longer captured session window', async () => {
    const { access, session } = await opened();
    // The session captured the original deadline; the host then pulls it in.
    await env.DB.prepare('UPDATE events SET rsvp_deadline_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', access.event.id).run();

    const refused = await submit(access, session, {
      version: 1, idempotencyKey: 'shortened', invitees: answers(session.household, 'declined'),
    });
    expect(refused.status).toBe(409);
  });

  it('needs a fresh lookup after the deadline is extended', async () => {
    const { access, session } = await opened();
    // This device's captured window has lapsed even though the event is open.
    await env.DB.prepare('UPDATE rsvp_sessions SET write_authority_deadline = ?')
      .bind('2020-01-01T00:00:00.000Z').run();

    const refused = await submit(access, session, {
      version: 1, idempotencyKey: 'extended', invitees: answers(session.household, 'declined'),
    });
    expect(refused.status).toBe(409);
    expect((await storedAttendance(session.household.id)).every((row) => row[2] === 'pending')).toBe(true);

    // Proving identity again restores the window.
    const again = await createApp().request(`/api/event/${access.event.slug}/rsvp/lookup`, {
      method: 'POST',
      headers: { ...writeHeaders(access.guest), 'cf-connecting-ip': '203.0.113.11' },
      body: JSON.stringify({ firstName: 'Henry Perkins' }),
    }, testEnv);
    const value = again.headers.get('set-cookie') ?? '';
    const renewed: Session = {
      cookie: `candidary_rsvp=${/candidary_rsvp=([^;,]+)/u.exec(value)![1]}; candidary_rsvp_csrf=${/candidary_rsvp_csrf=([^;,]+)/u.exec(value)![1]}`,
      csrf: /candidary_rsvp_csrf=([^;,]+)/u.exec(value)![1]!,
      token: /candidary_rsvp=([^;,]+)/u.exec(value)![1]!,
      household: (await again.json<any>()).data.household,
    };
    const accepted = await submit(access, renewed, {
      version: 1, idempotencyKey: 'extended-retry', invitees: answers(renewed.household, 'declined'),
    });
    expect(accepted.status).toBe(200);
  });
});

describe('the event start', () => {
  /**
   * Moves the event's own start behind the server clock.
   *
   * The deadline is deliberately left open and RSVP left on, so the only thing
   * that can refuse anything below is the start itself.
   */
  async function startTheEvent(access: Access) {
    await env.DB.prepare('UPDATE events SET event_start_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', access.event.id).run();
  }

  it('refuses a household read and a household write once the event has started', async () => {
    const { access, session } = await opened();
    await startTheEvent(access);

    const read = await createApp().request(
      `/api/event/${access.event.slug}/rsvp/household`,
      { headers: { cookie: session.cookie } },
      testEnv,
    );
    const written = await submit(access, session, {
      version: 1, idempotencyKey: 'after-start', invitees: answers(session.household, 'declined'),
    });

    expect([read.status, written.status]).toEqual([409, 409]);
    expect((await read.json<any>()).code).toBe('RSVP_CLOSED');
    expect((await written.json<any>()).code).toBe('RSVP_CLOSED');
    expect((await storedAttendance(session.household.id)).every((row) => row[2] === 'pending')).toBe(true);
  });

  it('replays a committed key before the start and refuses the same key after it', async () => {
    const { access, session } = await opened();
    const request = {
      version: 1,
      idempotencyKey: 'sent-just-before-the-start',
      invitees: answers(session.household, 'attending', 'Sam Rivera'),
    };
    await submit(access, session, request);

    const replayed = await submit(access, session, request);
    expect(replayed.status).toBe(200);
    expect((await replayed.json<any>()).data.replayed).toBe(true);

    await startTheEvent(access);
    const refused = await submit(access, session, request);

    // The service would have answered this exact key with a replayed success,
    // so a closure is proof the route refused before ever reaching it. RSVP has
    // left the guest experience entirely, replays included.
    expect(refused.status).toBe(409);
    expect((await refused.json<any>()).code).toBe('RSVP_CLOSED');
    expect(await env.DB.prepare('SELECT version FROM rsvp_households WHERE id = ?')
      .bind(session.household.id).first('version')).toBe(2);
  });

  it('refuses the household write in SQL rather than only at the route', async () => {
    const { access, session } = await opened();
    await startTheEvent(access);
    // Straight to the service, past the route's own check. A submission that
    // passed that check microseconds before the start would otherwise commit
    // after it, and closing that race is the whole reason the guard is in SQL.
    const auth = await new RsvpAuthService(testEnv).resolve(session.token);

    await expect(new RsvpService(testEnv).submitHousehold(auth, {
      version: 1,
      idempotencyKey: 'past-the-route',
      invitees: answers(session.household, 'attending', 'Sam Rivera'),
    })).rejects.toMatchObject({ code: 'RSVP_HOUSEHOLD_CONFLICT' });

    expect((await storedAttendance(session.household.id)).every((row) => row[2] === 'pending')).toBe(true);
    expect(await env.DB.prepare('SELECT version FROM rsvp_households WHERE id = ?')
      .bind(session.household.id).first('version')).toBe(1);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM rsvp_submission_receipts WHERE household_id = ?
    `).bind(session.household.id).first('count')).toBe(0);
  });
});

describe('replay and conflict', () => {
  it('replays a lost confirmation as success', async () => {
    const { access, session } = await opened();
    const request = {
      version: 1,
      idempotencyKey: 'lost-response',
      invitees: answers(session.household, 'attending', 'Sam Rivera'),
    };

    const first = await (await submit(access, session, request)).json<any>();
    const repeat = await submit(access, session, request);
    const repeated = await repeat.json<any>();

    expect(repeat.status).toBe(200);
    expect(repeated.replayed ?? repeated.data.replayed).toBe(true);
    expect(repeated.data.committedVersion).toBe(first.data.committedVersion);
    // Exactly one response was applied.
    expect(await env.DB.prepare('SELECT version FROM rsvp_households WHERE id = ?')
      .bind(session.household.id).first('version')).toBe(2);
  });

  it('replays a key even after the household moved on', async () => {
    const { access, session } = await opened();
    const first = {
      version: 1, idempotencyKey: 'early', invitees: answers(session.household, 'attending', 'Sam Rivera'),
    };
    await submit(access, session, first);
    await submit(access, session, {
      version: 2, idempotencyKey: 'later', invitees: answers(session.household, 'declined'),
    });

    // The guest's phone finally reports that its first send failed.
    const replay = await submit(access, session, first);
    const body = await replay.json<any>();

    expect(replay.status).toBe(200);
    expect(body.data.replayed).toBe(true);
    // The later answer stands: a replay reports, it does not re-apply.
    expect((await storedAttendance(session.household.id)).every((row) => row[2] === 'declined')).toBe(true);
  });

  it('refuses the same key carrying different answers', async () => {
    const { access, session } = await opened();
    await submit(access, session, {
      version: 1, idempotencyKey: 'reused', invitees: answers(session.household, 'attending', 'Sam Rivera'),
    });

    const refused = await submit(access, session, {
      version: 1, idempotencyKey: 'reused', invitees: answers(session.household, 'declined'),
    });

    expect(refused.status).toBe(409);
    expect((await refused.json<any>()).code).toBe('RSVP_SUBMISSION_CONFLICT');
    expect((await storedAttendance(session.household.id)).every((row) => row[2] === 'attending')).toBe(true);
  });

  it('refuses a stale version without overwriting the newer answer', async () => {
    const { access, session } = await opened();
    await submit(access, session, {
      version: 1, idempotencyKey: 'device-a', invitees: answers(session.household, 'attending', 'Sam Rivera'),
    });

    // A second device still holding version 1.
    const refused = await submit(access, session, {
      version: 1, idempotencyKey: 'device-b', invitees: answers(session.household, 'declined'),
    });
    const body = await refused.json<any>();

    expect(refused.status).toBe(409);
    expect(body.code).toBe('RSVP_HOUSEHOLD_CONFLICT');
    expect((await storedAttendance(session.household.id)).every((row) => row[2] === 'attending')).toBe(true);
    // The one error envelope carries a message only; the client re-reads the
    // current household instead of receiving a second shape in fieldErrors.
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId']);
    expect(JSON.stringify(body)).not.toContain('Perkins');
  });

  it('lets exactly one of two simultaneous sends win', async () => {
    const { access, session } = await opened();
    const [first, second] = await Promise.all([
      submit(access, session, {
        version: 1, idempotencyKey: 'race-a', invitees: answers(session.household, 'attending', 'Sam Rivera'),
      }),
      submit(access, session, {
        version: 1, idempotencyKey: 'race-b', invitees: answers(session.household, 'declined'),
      }),
    ]);

    const statuses = [first!.status, second!.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await env.DB.prepare('SELECT version FROM rsvp_households WHERE id = ?')
      .bind(session.household.id).first('version')).toBe(2);
  });

  it('does not retain a receipt for the concurrent submission that lost', async () => {
    const { access, session } = await opened();
    const requests = [
      {
        version: 1,
        idempotencyKey: 'loser-receipt-a',
        invitees: answers(session.household, 'attending', 'Sam Rivera'),
      },
      {
        version: 1,
        idempotencyKey: 'loser-receipt-b',
        invitees: answers(session.household, 'declined'),
      },
    ];
    const responses = await Promise.all(requests.map((request) => submit(access, session, request)));
    const losingIndex = responses.findIndex((response) => response.status === 409);

    expect(losingIndex).toBeGreaterThanOrEqual(0);
    const replay = await submit(access, session, requests[losingIndex]!);

    expect(replay.status).toBe(409);
    expect((await replay.json<any>()).code).toBe('RSVP_HOUSEHOLD_CONFLICT');
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM rsvp_submission_receipts WHERE household_id = ?
    `).bind(session.household.id).first('count')).toBe(1);
  });

  it('will not accept a submission without the RSVP CSRF pair', async () => {
    const { access, session } = await opened();
    const refused = await createApp().request(`/api/event/${access.event.slug}/rsvp/household`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: session.cookie,
        origin,
        // The event token, not the household one.
        'x-candidary-csrf': access.guest.csrf,
      },
      body: JSON.stringify({
        version: 1, idempotencyKey: 'wrong-scope', invitees: answers(session.household, 'declined'),
      }),
    }, testEnv);

    expect(refused.status).toBe(403);
    expect((await refused.json<any>()).code).toBe('CSRF_INVALID');
  });

  // A host edit that changes the roster shape also bumps the version, so this is
  // the ordinary collision — not an exotic one. It has to arrive as the conflict
  // the guest UI knows how to recover from, never as a validation refusal that
  // leaves them re-sending the same stale answer set forever.
  it('answers a host roster change with a conflict rather than a validation refusal', async () => {
    const { access, session } = await opened();
    const listed = await createApp().request(
      `/api/manage/events/${access.event.id}/rsvp/households`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    const household = (await listed.json<any>()).data.households[0];
    const current = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    const rosterVersion = (await current.json<any>()).data.event.rsvpRosterVersion;

    // The host adds a plus-one slot while the household is mid-answer, so the
    // guest's invitee set no longer matches the roster and the version moved.
    const edited = await createApp().request(
      `/api/manage/events/${access.event.id}/rsvp/households/${household.id}`,
      {
        method: 'PUT',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({
          label: household.label,
          plusOneSlots: 3,
          namedInvitees: session.household.invitees
            .filter((invitee) => invitee.kind === 'named')
            .map((invitee) => ({ id: invitee.id, displayName: invitee.displayName })),
          expectedVersion: household.version,
          expectedRosterVersion: rosterVersion,
        }),
      },
      testEnv,
    );
    expect(edited.status).toBe(200);

    const stale = await submit(access, session, {
      version: session.household.version,
      idempotencyKey: 'stale-after-roster-edit',
      invitees: answers(session.household, 'attending', 'Jordan Lee'),
    });

    expect(stale.status).toBe(409);
    expect((await stale.json<any>()).code).toBe('RSVP_HOUSEHOLD_CONFLICT');
    // Nothing was written: the host's two named guests and three slots are all
    // still unanswered, so the guest's re-read finds the roster the host made.
    const stored = await storedAttendance(session.household.id);
    expect(stored).toHaveLength(5);
    expect(stored.every(([, , attendance]) => attendance === 'pending')).toBe(true);
  });
});

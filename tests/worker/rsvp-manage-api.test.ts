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

interface Invitee {
  id: string;
  kind: 'named' | 'plus_one';
  displayName: string | null;
  attendance: 'pending' | 'attending' | 'declined';
  order: number;
}

interface HouseholdDetail {
  id: string;
  householdKey: string;
  label: string;
  plusOneSlots: number;
  version: number;
  archivedAt: string | null;
  invitees: Invitee[];
  firstRespondedAt: string | null;
  latestRespondedAt: string | null;
  latestActor: 'household' | 'host' | null;
  updatedAt: string;
}

const DETAIL_KEYS = [
  'archivedAt',
  'firstRespondedAt',
  'householdKey',
  'id',
  'invitees',
  'label',
  'latestActor',
  'latestRespondedAt',
  'plusOneSlots',
  'updatedAt',
  'version',
];

const INVITEE_KEYS = ['attendance', 'displayName', 'id', 'kind', 'order'];

const LIST_ITEM_KEYS = [
  'archivedAt',
  'attending',
  'awaitingResponse',
  'declined',
  'firstRespondedAt',
  'householdKey',
  'id',
  'invitedCapacity',
  'label',
  'latestActor',
  'latestRespondedAt',
  'updatedAt',
  'version',
];

const SUMMARY_KEYS = [
  'attending',
  'awaitingResponse',
  'declined',
  'householdsAwaitingResponse',
  'householdsResponded',
  'invitedCapacity',
  'namedInvitees',
  'plusOneCapacity',
];

const BASE_ROSTER = [
  'household_key,household_label,invitee_name,plus_one_slots',
  'perkins,Perkins household,Henry Perkins,1',
  'perkins,Perkins household,Jordan Perkins,1',
  'rivera,Rivera household,Sam Rivera,0',
].join('\n');

function manage(
  access: Access,
  suffix: string,
  init: RequestInit = {},
  includeCsrf = true,
) {
  const method = init.method ?? 'GET';
  const headers = method === 'GET'
    ? { cookie: access.manager.cookie, ...(init.headers ?? {}) }
    : includeCsrf
      ? { ...writeHeaders(access.manager), ...(init.headers ?? {}) }
      : {
          'content-type': 'application/json',
          cookie: access.manager.cookie,
          origin,
          ...(init.headers ?? {}),
        };
  return createApp().request(
    `/api/manage/events/${access.event.id}/rsvp${suffix}`,
    { ...init, method, headers },
    testEnv,
  );
}

function createHousehold(
  access: Access,
  input: {
    householdKey: string;
    label: string;
    plusOneSlots: number;
    namedInvitees: string[];
    expectedRosterVersion: number;
  },
) {
  return manage(access, '/households', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

function updateHousehold(
  access: Access,
  householdId: string,
  input: Record<string, unknown>,
) {
  return manage(access, `/households/${householdId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

function correctHousehold(
  access: Access,
  householdId: string,
  input: Record<string, unknown>,
) {
  return manage(access, `/households/${householdId}/response`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

function archiveHousehold(
  access: Access,
  householdId: string,
  expectedVersion: number,
  expectedRosterVersion: number,
) {
  return manage(access, `/households/${householdId}/archive`, {
    method: 'POST',
    body: JSON.stringify({ expectedVersion, expectedRosterVersion }),
  });
}

async function getDetail(access: Access, householdId: string): Promise<HouseholdDetail> {
  const response = await manage(access, `/households/${householdId}`);
  expect(response.status).toBe(200);
  return (await response.json<any>()).data;
}

async function getList(
  access: Access,
  params: Record<string, string> = {},
): Promise<{ households: any[]; nextCursor: string | null }> {
  const query = new URLSearchParams(params).toString();
  const response = await manage(access, `/households${query ? `?${query}` : ''}`);
  expect(response.status).toBe(200);
  return (await response.json<any>()).data;
}

function hostAnswers(
  detail: HouseholdDetail,
  attendance: 'attending' | 'declined',
  plusOneName = 'Taylor Guest',
) {
  return detail.invitees.map((invitee) => ({
    id: invitee.id,
    attendance,
    displayName: invitee.kind === 'plus_one' && attendance === 'attending'
      ? plusOneName
      : null,
  }));
}

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

async function lookupHousehold(access: Access, firstName: string) {
  const response = await createApp().request(`/api/event/${access.event.slug}/rsvp/lookup`, {
    method: 'POST',
    headers: {
      ...writeHeaders(access.guest),
      'cf-connecting-ip': `203.0.113.${Math.floor(Math.random() * 100) + 20}`,
    },
    body: JSON.stringify({ firstName }),
  }, testEnv);
  const value = response.headers.get('set-cookie') ?? '';
  const session = /candidary_rsvp=([^;,]+)/u.exec(value)?.[1];
  const csrf = /candidary_rsvp_csrf=([^;,]+)/u.exec(value)?.[1];
  if (!session || !csrf) throw new Error(`Expected RSVP cookies, received: ${value}`);
  return {
    cookie: `candidary_rsvp=${session}; candidary_rsvp_csrf=${csrf}`,
    csrf,
    household: (await response.json<any>()).data.household as HouseholdDetail,
  };
}

beforeEach(resetDatabase);

describe('manager household roster operations', () => {
  it('creates, reads, renames, and extends an unresponded household with stable wire shapes', async () => {
    const access = await eventAccess();
    const created = await createHousehold(access, {
      householdKey: 'oneil',
      label: 'O’Neil household',
      plusOneSlots: 2,
      namedInvitees: ['Ana O’Neil', 'Bea O’Neil'],
      expectedRosterVersion: 0,
    });
    const createdBody = await created.json<any>();

    expect(created.status).toBe(201);
    expect(Object.keys(createdBody.data).sort()).toEqual(['household', 'rosterVersion']);
    expect(createdBody.data.rosterVersion).toBe(1);
    const household = createdBody.data.household as HouseholdDetail;
    expect(Object.keys(household).sort()).toEqual(DETAIL_KEYS);
    expect(household.label).toBe('O’Neil household');
    expect(household.invitees).toHaveLength(4);
    expect(household.invitees.every((invitee) => invitee.attendance === 'pending')).toBe(true);
    expect(household.invitees.map((invitee) => Object.keys(invitee).sort()))
      .toEqual(household.invitees.map(() => INVITEE_KEYS));
    const originalPlusOneIds = household.invitees
      .filter((invitee) => invitee.kind === 'plus_one')
      .map((invitee) => invitee.id);

    const edited = await updateHousehold(access, household.id, {
      label: 'O’Neil family',
      plusOneSlots: 3,
      namedInvitees: [
        { id: household.invitees[0]!.id, displayName: 'Ana O’Neil' },
        { id: household.invitees[1]!.id, displayName: 'Beatrice O’Neil' },
        // Immediate-answer fields on an unresponded household do not create a
        // partial response. Every addition still starts pending.
        { id: null, displayName: 'Casey O’Neil', attendance: 'attending' },
      ],
      newPlusOneResponses: [{ attendance: 'attending', displayName: 'Ignored Guest' }],
      expectedVersion: household.version,
      expectedRosterVersion: 1,
    });
    const editedBody = await edited.json<any>();

    expect(edited.status).toBe(200);
    expect(editedBody.data.rosterVersion).toBe(2);
    expect(editedBody.data.household.version).toBe(2);
    expect(editedBody.data.household.label).toBe('O’Neil family');
    expect(editedBody.data.household.invitees.find(
      (invitee: Invitee) => invitee.id === household.invitees[1]!.id,
    ).displayName).toBe('Beatrice O’Neil');
    expect(editedBody.data.household.invitees.filter(
      (invitee: Invitee) => invitee.kind === 'plus_one',
    ).slice(0, 2).map((invitee: Invitee) => invitee.id)).toEqual(originalPlusOneIds);
    expect(editedBody.data.household.invitees.every(
      (invitee: Invitee) => invitee.attendance === 'pending',
    )).toBe(true);

    const detail = await getDetail(access, household.id);
    expect(Object.keys(detail).sort()).toEqual(DETAIL_KEYS);
    expect(detail).toEqual(editedBody.data.household);
  });

  it('refuses manual create or edit when an active household has no named invitee', async () => {
    const access = await eventAccess();
    const empty = await createHousehold(access, {
      householdKey: 'empty',
      label: 'Empty household',
      plusOneSlots: 1,
      namedInvitees: [],
      expectedRosterVersion: 0,
    });
    expect(empty.status).toBe(422);

    const created = await createHousehold(access, {
      householdKey: 'named',
      label: 'Named household',
      plusOneSlots: 1,
      namedInvitees: ['Named Guest'],
      expectedRosterVersion: 0,
    });
    const detail = (await created.json<any>()).data.household as HouseholdDetail;
    const removed = await updateHousehold(access, detail.id, {
      label: detail.label,
      plusOneSlots: 1,
      namedInvitees: [],
      expectedVersion: detail.version,
      expectedRosterVersion: 1,
    });

    expect(removed.status).toBe(422);
    expect((await getDetail(access, detail.id)).invitees.filter(
      (invitee) => invitee.kind === 'named',
    )).toHaveLength(1);
  });

  it('refuses RSVP activation when an active household has no named invitee', async () => {
    const access = await eventAccess();
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO rsvp_households (
        id, event_id, household_key, label, created_at, updated_at
      ) VALUES (?, ?, 'nameless', 'Nameless household', ?, ?)
    `).bind(crypto.randomUUID(), access.event.id, now, now).run();

    const opened = await applySettings(access, {
      rsvpEnabled: true,
      rsvpRosterVersion: 0,
    });
    expect(opened.status).toBe(409);
    expect((await opened.json<any>()).code).toBe('RSVP_ROSTER_INVALID');
  });

  it('requires atomic answers for additions to a responded household and refuses named removal', async () => {
    const access = await eventAccess();
    const created = await createHousehold(access, {
      householdKey: 'responded',
      label: 'Responded household',
      plusOneSlots: 1,
      namedInvitees: ['Existing Guest'],
      expectedRosterVersion: 0,
    });
    const detail = (await created.json<any>()).data.household as HouseholdDetail;
    const corrected = await correctHousehold(access, detail.id, {
      expectedVersion: 1,
      expectedRosterVersion: 1,
      invitees: hostAnswers(detail, 'attending'),
    });
    expect(corrected.status).toBe(200);

    const missingAnswers = await updateHousehold(access, detail.id, {
      label: detail.label,
      plusOneSlots: 2,
      namedInvitees: [
        { id: detail.invitees[0]!.id, displayName: 'Existing Guest' },
        { id: null, displayName: 'New Guest' },
      ],
      expectedVersion: 2,
      expectedRosterVersion: 2,
    });
    expect(missingAnswers.status).toBe(422);
    expect((await getDetail(access, detail.id)).invitees).toHaveLength(2);

    const removed = await updateHousehold(access, detail.id, {
      label: detail.label,
      plusOneSlots: 1,
      namedInvitees: [],
      expectedVersion: 2,
      expectedRosterVersion: 2,
    });
    expect(removed.status).toBe(409);

    const extended = await updateHousehold(access, detail.id, {
      label: 'Responded family',
      plusOneSlots: 2,
      namedInvitees: [
        { id: detail.invitees[0]!.id, displayName: 'Existing Guest' },
        { id: null, displayName: 'New Guest', attendance: 'attending' },
      ],
      newPlusOneResponses: [{ attendance: 'declined', displayName: 'Must clear' }],
      expectedVersion: 2,
      expectedRosterVersion: 2,
    });
    const value = (await extended.json<any>()).data;

    expect(extended.status).toBe(200);
    expect(value.rosterVersion).toBe(3);
    expect(value.household.version).toBe(3);
    expect(value.household.invitees.every(
      (invitee: Invitee) => invitee.attendance !== 'pending',
    )).toBe(true);
    expect(value.household.invitees.find(
      (invitee: Invitee) => invitee.displayName === 'New Guest',
    ).attendance).toBe('attending');
    const newestPlusOne = value.household.invitees
      .filter((invitee: Invitee) => invitee.kind === 'plus_one')
      .at(-1);
    expect(newestPlusOne).toMatchObject({ attendance: 'declined', displayName: null });
  });

  it('grows plus-one capacity by appending IDs and only shrinks highest declined slots', async () => {
    const access = await eventAccess();
    const created = await createHousehold(access, {
      householdKey: 'slots',
      label: 'Slots household',
      plusOneSlots: 3,
      namedInvitees: ['Slot Owner'],
      expectedRosterVersion: 0,
    });
    const detail = (await created.json<any>()).data.household as HouseholdDetail;
    const plusOnes = detail.invitees.filter((invitee) => invitee.kind === 'plus_one');
    await correctHousehold(access, detail.id, {
      expectedVersion: 1,
      expectedRosterVersion: 1,
      invitees: [
        { id: detail.invitees[0]!.id, attendance: 'attending', displayName: null },
        { id: plusOnes[0]!.id, attendance: 'declined', displayName: null },
        { id: plusOnes[1]!.id, attendance: 'attending', displayName: 'Kept Guest' },
        { id: plusOnes[2]!.id, attendance: 'declined', displayName: null },
      ],
    });

    const shrunk = await updateHousehold(access, detail.id, {
      label: detail.label,
      plusOneSlots: 2,
      namedInvitees: [{ id: detail.invitees[0]!.id, displayName: 'Slot Owner' }],
      expectedVersion: 2,
      expectedRosterVersion: 2,
    });
    const shrunkValue = (await shrunk.json<any>()).data.household as HouseholdDetail;
    expect(shrunk.status).toBe(200);
    expect(shrunkValue.invitees.filter((invitee) => invitee.kind === 'plus_one')
      .map((invitee) => invitee.id)).toEqual([plusOnes[0]!.id, plusOnes[1]!.id]);

    const blocked = await updateHousehold(access, detail.id, {
      label: detail.label,
      plusOneSlots: 1,
      namedInvitees: [{ id: detail.invitees[0]!.id, displayName: 'Slot Owner' }],
      expectedVersion: 3,
      expectedRosterVersion: 3,
    });
    expect(blocked.status).toBe(409);

    const grown = await updateHousehold(access, detail.id, {
      label: detail.label,
      plusOneSlots: 3,
      namedInvitees: [{ id: detail.invitees[0]!.id, displayName: 'Slot Owner' }],
      newPlusOneResponses: [{ attendance: 'declined', displayName: null }],
      expectedVersion: 3,
      expectedRosterVersion: 3,
    });
    const grownPlusOnes = (await grown.json<any>()).data.household.invitees
      .filter((invitee: Invitee) => invitee.kind === 'plus_one') as Invitee[];

    expect(grown.status).toBe(200);
    expect(grownPlusOnes.slice(0, 2).map((invitee) => invitee.id))
      .toEqual([plusOnes[0]!.id, plusOnes[1]!.id]);
    expect(grownPlusOnes[2]!.id).not.toBe(plusOnes[2]!.id);
  });

  it('rejects lookup collisions on create and revalidates the whole roster on every edit', async () => {
    const access = await eventAccess();
    const first = await createHousehold(access, {
      householdKey: 'lee-a',
      label: 'Lee A',
      plusOneSlots: 0,
      namedInvitees: ['Alex Lee', 'Dana One'],
      expectedRosterVersion: 0,
    });
    const second = await createHousehold(access, {
      householdKey: 'lee-b',
      label: 'Lee B',
      plusOneSlots: 0,
      namedInvitees: ['Alex Lee', 'Chris Two'],
      expectedRosterVersion: 1,
    });
    const secondDetail = (await second.json<any>()).data.household as HouseholdDetail;

    const unresolvable = await createHousehold(access, {
      householdKey: 'lee-c',
      label: 'Lee C',
      plusOneSlots: 0,
      namedInvitees: ['Alex Lee'],
      expectedRosterVersion: 2,
    });
    expect(unresolvable.status).toBe(409);
    expect((await unresolvable.json<any>()).code).toBe('RSVP_ROSTER_INVALID');

    const firstDetail = (await first.json<any>()).data.household as HouseholdDetail;
    const chrisDigest = await env.DB.prepare(`
      SELECT lookup_digest FROM rsvp_invitees WHERE household_id = ? AND display_name = 'Chris Two'
    `).bind(secondDetail.id).first<string>('lookup_digest');
    await env.DB.prepare(`
      UPDATE rsvp_invitees SET lookup_digest = ?
      WHERE household_id = ? AND display_name = 'Dana One'
    `).bind(chrisDigest, firstDetail.id).run();

    const labelOnly = await updateHousehold(access, secondDetail.id, {
      label: 'Still invalid after label edit',
      plusOneSlots: 0,
      namedInvitees: secondDetail.invitees.map((invitee) => ({
        id: invitee.id,
        displayName: invitee.displayName,
      })),
      expectedVersion: 1,
      expectedRosterVersion: 2,
    });
    expect(labelOnly.status).toBe(409);
    expect((await labelOnly.json<any>()).code).toBe('RSVP_ROSTER_INVALID');
    expect(await env.DB.prepare('SELECT rsvp_roster_version FROM events WHERE id = ?')
      .bind(access.event.id).first('rsvp_roster_version')).toBe(2);
  });
});

describe('manager response correction and conflicts', () => {
  it('corrects a response after the guest deadline and advances both versions', async () => {
    const access = await eventAccess();
    await importRoster(access, BASE_ROSTER);
    const first = (await getList(access)).households[0]!;
    const detail = await getDetail(access, first.id);
    await env.DB.prepare('UPDATE events SET rsvp_deadline_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', access.event.id).run();

    const corrected = await correctHousehold(access, detail.id, {
      expectedVersion: detail.version,
      expectedRosterVersion: 1,
      invitees: hostAnswers(detail, 'attending', 'After Deadline'),
    });
    const value = (await corrected.json<any>()).data;

    expect(corrected.status).toBe(200);
    expect(value.rosterVersion).toBe(2);
    expect(value.household.version).toBe(2);
    expect(value.household.latestActor).toBe('host');
    expect(value.household.firstRespondedAt).toMatch(/Z$/u);
    expect(value.household.latestRespondedAt).toMatch(/Z$/u);
    expect(value.household.invitees.every(
      (invitee: Invitee) => invitee.attendance === 'attending',
    )).toBe(true);
  });

  it('returns one message-only conflict envelope for stale household or roster versions', async () => {
    const access = await eventAccess();
    const created = await createHousehold(access, {
      householdKey: 'conflict',
      label: 'Conflict household',
      plusOneSlots: 0,
      namedInvitees: ['Conflict Guest'],
      expectedRosterVersion: 0,
    });
    const detail = (await created.json<any>()).data.household as HouseholdDetail;
    await updateHousehold(access, detail.id, {
      label: 'Winner',
      plusOneSlots: 0,
      namedInvitees: [{ id: detail.invitees[0]!.id, displayName: 'Conflict Guest' }],
      expectedVersion: 1,
      expectedRosterVersion: 1,
    });

    for (const input of [
      { expectedVersion: 1, expectedRosterVersion: 2 },
      { expectedVersion: 2, expectedRosterVersion: 1 },
    ]) {
      const stale = await updateHousehold(access, detail.id, {
        label: 'Loser',
        plusOneSlots: 0,
        namedInvitees: [{ id: detail.invitees[0]!.id, displayName: 'Conflict Guest' }],
        ...input,
      });
      const body = await stale.json<any>();
      expect(stale.status).toBe(409);
      expect(body.code).toBe('RSVP_HOUSEHOLD_CONFLICT');
      expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId']);
    }
    expect((await getDetail(access, detail.id)).label).toBe('Winner');
  });

  it('never silently overwrites when a household and host correct the same version', async () => {
    const access = await eventAccess();
    await importRoster(access, [
      'household_key,household_label,invitee_name,plus_one_slots',
      'race,Race household,Race Guest,1',
    ].join('\n'));
    await openRsvp(access);
    const rsvp = await lookupHousehold(access, 'Race Guest');
    const detail = await getDetail(access, rsvp.household.id);
    const guestRequest = {
      version: 1,
      idempotencyKey: 'guest-host-race',
      invitees: detail.invitees.map((invitee) => ({
        id: invitee.id,
        attendance: 'declined',
        displayName: null,
      })),
    };

    const [guest, host] = await Promise.all([
      createApp().request(`/api/event/${access.event.slug}/rsvp/household`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: rsvp.cookie,
          origin,
          'x-candidary-rsvp-csrf': rsvp.csrf,
        },
        body: JSON.stringify(guestRequest),
      }, testEnv),
      correctHousehold(access, detail.id, {
        expectedVersion: 1,
        expectedRosterVersion: 1,
        invitees: hostAnswers(detail, 'attending', 'Host Guest'),
      }),
    ]);

    expect([guest.status, host.status].sort()).toEqual([200, 409]);
    const stored = await getDetail(access, detail.id);
    expect(new Set(stored.invitees.map((invitee) => invitee.attendance)).size).toBe(1);
    expect(stored.version).toBe(2);
  });

  it('replays a successful household key after a later host correction without reapplying it', async () => {
    const access = await eventAccess();
    await importRoster(access, [
      'household_key,household_label,invitee_name,plus_one_slots',
      'host-replay,Host replay household,Replay Guest,0',
    ].join('\n'));
    await openRsvp(access);
    const rsvp = await lookupHousehold(access, 'Replay Guest');
    const detail = await getDetail(access, rsvp.household.id);
    const request = {
      version: 1,
      idempotencyKey: 'before-host-correction',
      invitees: hostAnswers(detail, 'attending'),
    };
    const submitted = await createApp().request(
      `/api/event/${access.event.slug}/rsvp/household`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: rsvp.cookie,
          origin,
          'x-candidary-rsvp-csrf': rsvp.csrf,
        },
        body: JSON.stringify(request),
      },
      testEnv,
    );
    expect(submitted.status).toBe(200);
    await correctHousehold(access, detail.id, {
      expectedVersion: 2,
      expectedRosterVersion: 1,
      invitees: hostAnswers(detail, 'declined'),
    });

    const replay = await createApp().request(
      `/api/event/${access.event.slug}/rsvp/household`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: rsvp.cookie,
          origin,
          'x-candidary-rsvp-csrf': rsvp.csrf,
        },
        body: JSON.stringify(request),
      },
      testEnv,
    );
    const replayed = await replay.json<any>();

    expect(replay.status).toBe(200);
    expect(replayed.data.replayed).toBe(true);
    expect(replayed.data.committedVersion).toBe(2);
    expect((await getDetail(access, detail.id)).invitees[0]!.attendance).toBe('declined');
  });

  it('replays a successful household key after supported roster edits without overwriting them', async () => {
    const access = await eventAccess();
    await importRoster(access, [
      'household_key,household_label,invitee_name,plus_one_slots',
      'roster-replay,Roster replay household,Original Guest,1',
    ].join('\n'));
    await openRsvp(access);
    const rsvp = await lookupHousehold(access, 'Original Guest');
    const detail = await getDetail(access, rsvp.household.id);
    const named = detail.invitees.find((invitee) => invitee.kind === 'named')!;
    const plusOne = detail.invitees.find((invitee) => invitee.kind === 'plus_one')!;
    const request = {
      version: 1,
      idempotencyKey: 'before-roster-edits',
      invitees: [
        { id: named.id, attendance: 'attending', displayName: null },
        { id: plusOne.id, attendance: 'declined', displayName: 'Ignored old name' },
      ],
    };
    const submitted = await createApp().request(
      `/api/event/${access.event.slug}/rsvp/household`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: rsvp.cookie,
          origin,
          'x-candidary-rsvp-csrf': rsvp.csrf,
        },
        body: JSON.stringify(request),
      },
      testEnv,
    );
    expect(submitted.status).toBe(200);

    const editedResponse = await updateHousehold(access, detail.id, {
      label: detail.label,
      plusOneSlots: 2,
      namedInvitees: [
        { id: named.id, displayName: 'Renamed Guest' },
        { id: null, displayName: 'Added Guest', attendance: 'declined' },
      ],
      newPlusOneResponses: [{ attendance: 'declined', displayName: 'Ignored new name' }],
      expectedVersion: 2,
      expectedRosterVersion: 1,
    });
    const edited = (await editedResponse.json<any>()).data.household as HouseholdDetail;
    expect(editedResponse.status).toBe(200);
    expect(edited.version).toBe(3);
    expect(edited.invitees).toHaveLength(4);
    expect(edited.invitees.find((invitee) => invitee.id === named.id)?.displayName)
      .toBe('Renamed Guest');

    const replay = await createApp().request(
      `/api/event/${access.event.slug}/rsvp/household`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: rsvp.cookie,
          origin,
          'x-candidary-rsvp-csrf': rsvp.csrf,
        },
        body: JSON.stringify(request),
      },
      testEnv,
    );
    const replayed = await replay.json<any>();

    expect(replay.status).toBe(200);
    expect(replayed.data.replayed).toBe(true);
    expect(replayed.data.committedVersion).toBe(2);

    const irrelevantNameReplay = await createApp().request(
      `/api/event/${access.event.slug}/rsvp/household`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: rsvp.cookie,
          origin,
          'x-candidary-rsvp-csrf': rsvp.csrf,
        },
        body: JSON.stringify({
          ...request,
          invitees: request.invitees.map((invitee) => (
            invitee.id === plusOne.id
              ? { ...invitee, displayName: 'Another ignored name' }
              : invitee
          )),
        }),
      },
      testEnv,
    );
    expect(irrelevantNameReplay.status).toBe(200);
    expect((await irrelevantNameReplay.json<any>()).data.replayed).toBe(true);

    const stored = await getDetail(access, detail.id);
    expect(stored.version).toBe(3);
    expect(stored.invitees.map((invitee) => invitee.id))
      .toEqual(edited.invitees.map((invitee) => invitee.id));
    expect(stored.invitees.find((invitee) => invitee.id === named.id)?.displayName)
      .toBe('Renamed Guest');
  });
});

describe('manager summary, filters, and pagination', () => {
  it('derives active totals from invitee rows and excludes an archived household', async () => {
    const access = await eventAccess();
    await importRoster(access, BASE_ROSTER);
    const listed = await getList(access);
    const perkins = listed.households.find((household) => household.householdKey === 'perkins')!;
    const rivera = listed.households.find((household) => household.householdKey === 'rivera')!;
    const perkinsDetail = await getDetail(access, perkins.id);
    const riveraDetail = await getDetail(access, rivera.id);

    await correctHousehold(access, perkins.id, {
      expectedVersion: 1,
      expectedRosterVersion: 1,
      invitees: [
        { id: perkinsDetail.invitees[0]!.id, attendance: 'attending', displayName: null },
        { id: perkinsDetail.invitees[1]!.id, attendance: 'declined', displayName: null },
        { id: perkinsDetail.invitees[2]!.id, attendance: 'attending', displayName: 'Guest Name' },
      ],
    });
    await archiveHousehold(access, rivera.id, riveraDetail.version, 2);

    const response = await manage(access, '/summary');
    const summary = (await response.json<any>()).data;
    expect(response.status).toBe(200);
    expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS);
    expect(summary).toEqual({
      invitedCapacity: 3,
      namedInvitees: 2,
      plusOneCapacity: 1,
      attending: 2,
      declined: 1,
      awaitingResponse: 0,
      householdsResponded: 1,
      householdsAwaitingResponse: 0,
    });
  });

  it('searches labels and every stored invitee name with escaped LIKE and reapplies state filters', async () => {
    const access = await eventAccess();
    const special = await createHousehold(access, {
      householdKey: 'special',
      label: '100% household',
      plusOneSlots: 1,
      namedInvitees: ['Amy_Unique'],
      expectedRosterVersion: 0,
    });
    const specialDetail = (await special.json<any>()).data.household as HouseholdDetail;
    await correctHousehold(access, specialDetail.id, {
      expectedVersion: 1,
      expectedRosterVersion: 1,
      invitees: [
        { id: specialDetail.invitees[0]!.id, attendance: 'attending', displayName: null },
        { id: specialDetail.invitees[1]!.id, attendance: 'attending', displayName: 'Plus%_Guest' },
      ],
    });
    const pending = await createHousehold(access, {
      householdKey: 'pending',
      label: '1000 household',
      plusOneSlots: 0,
      namedInvitees: ['AmyXUnique'],
      expectedRosterVersion: 2,
    });
    const pendingDetail = (await pending.json<any>()).data.household as HouseholdDetail;
    await archiveHousehold(access, pendingDetail.id, 1, 3);

    const byPercent = await getList(access, { query: '%' });
    expect(byPercent.households.map((household) => household.householdKey)).toEqual(['special']);
    const byUnderscore = await getList(access, { query: '_' });
    expect(byUnderscore.households.map((household) => household.householdKey)).toEqual(['special']);
    const byPlusOne = await getList(access, { query: 'Plus%_Guest', state: 'responded' });
    expect(byPlusOne.households.map((household) => household.householdKey)).toEqual(['special']);
    const awaiting = await getList(access, { state: 'awaiting' });
    expect(awaiting.households).toHaveLength(0);
    const archived = await getList(access, { state: 'archived', query: 'AmyX' });
    expect(archived.households.map((household) => household.householdKey)).toEqual(['pending']);
    expect(Object.keys(byPercent.households[0]!).sort()).toEqual(LIST_ITEM_KEYS);
  });

  it('paginates fifty at a time and rejects every malformed cursor shape identically', async () => {
    const access = await eventAccess();
    const csv = [
      'household_key,household_label,invitee_name,plus_one_slots',
      ...Array.from({ length: 55 }, (_, index) => (
        `page-${String(index).padStart(2, '0')},Page ${index},Unique Guest ${index},0`
      )),
    ].join('\n');
    await importRoster(access, csv);

    const first = await getList(access);
    expect(first.households).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await getList(access, { cursor: first.nextCursor! });
    expect(second.households).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.households, ...second.households].map((row) => row.id)).size).toBe(55);

    // A cursor is only a position: current query/state remain explicit and are
    // applied again rather than being inherited or bypassed.
    const crossFilter = await getList(access, {
      cursor: first.nextCursor!,
      state: 'responded',
      query: 'does-not-exist',
    });
    expect(crossFilter).toEqual({ households: [], nextCursor: null });

    const malformed = [
      'not-json',
      base64url({ updatedAt: new Date().toISOString(), id: 'not-a-uuid' }),
      base64url({ updatedAt: '2026-07-30', id: crypto.randomUUID() }),
      base64url({
        updatedAt: new Date().toISOString(),
        id: crypto.randomUUID(),
        query: 'cursor-state-does-not-belong-here',
      }),
      btoa(`${JSON.stringify({
        updatedAt: new Date().toISOString(),
        id: crypto.randomUUID(),
      })} `),
      'x'.repeat(513),
    ];
    for (const cursor of malformed) {
      const response = await manage(access, `/households?cursor=${encodeURIComponent(cursor)}`);
      const body = await response.json<any>();
      expect(response.status).toBe(422);
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.message).toBe('The guest list page cursor is invalid.');
    }
  });
});

describe('manager archive and CSV export', () => {
  it('archives without deleting, advances versions, and revokes household sessions', async () => {
    const access = await eventAccess();
    await importRoster(access, [
      'household_key,household_label,invitee_name,plus_one_slots',
      'archive,Archive household,Archive Guest,0',
    ].join('\n'));
    await openRsvp(access);
    const rsvp = await lookupHousehold(access, 'Archive Guest');
    const detail = await getDetail(access, rsvp.household.id);

    const archived = await archiveHousehold(access, detail.id, 1, 1);
    const value = (await archived.json<any>()).data;
    expect(archived.status).toBe(200);
    expect(value.rosterVersion).toBe(2);
    expect(value.household.version).toBe(2);
    expect(value.household.archivedAt).toMatch(/Z$/u);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM rsvp_households WHERE id = ?')
      .bind(detail.id).first('count')).toBe(1);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM rsvp_sessions
      WHERE household_id = ? AND revoked_at IS NOT NULL
    `).bind(detail.id).first('count')).toBe(1);

    const guestRead = await createApp().request(
      `/api/event/${access.event.slug}/rsvp/household`,
      { headers: { cookie: rsvp.cookie } },
      testEnv,
    );
    expect(guestRead.status).toBe(401);
    expect((await guestRead.json<any>()).code).toBe('RSVP_SESSION_REQUIRED');
    expect((await getList(access)).households).toHaveLength(0);
    expect((await getList(access, { state: 'archived' })).households).toHaveLength(1);
  });

  it('exports pending and archived rows with exact safe columns, timestamps, timezone, and download headers', async () => {
    const access = await eventAccess('Formula & Archive');
    const formula = await createHousehold(access, {
      householdKey: 'formula',
      label: '=SUM(1,2)',
      plusOneSlots: 1,
      namedInvitees: ['+Alex'],
      expectedRosterVersion: 0,
    });
    const formulaDetail = (await formula.json<any>()).data.household as HouseholdDetail;
    await correctHousehold(access, formulaDetail.id, {
      expectedVersion: 1,
      expectedRosterVersion: 1,
      invitees: [
        { id: formulaDetail.invitees[0]!.id, attendance: 'attending', displayName: null },
        { id: formulaDetail.invitees[1]!.id, attendance: 'attending', displayName: '-Guest' },
      ],
    });
    const pending = await createHousehold(access, {
      householdKey: 'archive',
      label: '@Archived',
      plusOneSlots: 0,
      namedInvitees: ['Pending Guest'],
      expectedRosterVersion: 2,
    });
    const pendingDetail = (await pending.json<any>()).data.household as HouseholdDetail;
    await archiveHousehold(access, pendingDetail.id, 1, 3);
    await env.DB.prepare('UPDATE events SET event_timezone = ? WHERE id = ?')
      .bind('Pacific/Kiritimati', access.event.id).run();

    const response = await manage(access, '/export.csv');
    const csv = await response.text();
    const filenameDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Kiritimati',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date()).reduce<Record<string, string>>((parts, part) => {
      if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
        parts[part.type] = part.value;
      }
      return parts;
    }, {});
    const header = [
      'household_key',
      'household_label',
      'household_archived_at',
      'member_kind',
      'member_name',
      'attendance',
      'member_order',
      'household_version',
      'first_responded_at',
      'last_responded_at',
      'last_actor',
      'event_timezone',
    ].join(',');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="${access.event.slug}-rsvp-`
      + `${filenameDate.year}-${filenameDate.month}-${filenameDate.day}.csv"`,
    );
    expect(csv.split(/\r?\n/u)[0]).toBe(header);
    expect(csv).toContain(`"'=SUM(1,2)"`);
    expect(csv).toContain("'+Alex");
    expect(csv).toContain("'-Guest");
    expect(csv).toContain("'@Archived");
    expect(csv).toContain(',pending,');
    expect(csv).toContain(',Pacific/Kiritimati');
    expect(csv).toMatch(/,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z,/u);
    expect(csv).toMatch(/archive,'@Archived,\d{4}-\d{2}-\d{2}T/u);
  });

  it('requires the manager CSRF pair on every mutation route', async () => {
    const access = await eventAccess();
    const created = await createHousehold(access, {
      householdKey: 'csrf',
      label: 'CSRF household',
      plusOneSlots: 0,
      namedInvitees: ['CSRF Guest'],
      expectedRosterVersion: 0,
    });
    const detail = (await created.json<any>()).data.household as HouseholdDetail;
    const requests: Array<[string, RequestInit]> = [
      ['/households', {
        method: 'POST',
        body: JSON.stringify({
          householdKey: 'new',
          label: 'New',
          plusOneSlots: 0,
          namedInvitees: ['New Guest'],
          expectedRosterVersion: 1,
        }),
      }],
      [`/households/${detail.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          label: detail.label,
          plusOneSlots: 0,
          namedInvitees: [{ id: detail.invitees[0]!.id, displayName: 'CSRF Guest' }],
          expectedVersion: 1,
          expectedRosterVersion: 1,
        }),
      }],
      [`/households/${detail.id}/response`, {
        method: 'PUT',
        body: JSON.stringify({
          expectedVersion: 1,
          expectedRosterVersion: 1,
          invitees: hostAnswers(detail, 'declined'),
        }),
      }],
      [`/households/${detail.id}/archive`, {
        method: 'POST',
        body: JSON.stringify({ expectedVersion: 1, expectedRosterVersion: 1 }),
      }],
    ];

    for (const [path, init] of requests) {
      const response = await manage(access, path, init, false);
      expect(response.status).toBe(403);
      expect((await response.json<any>()).code).toBe('CSRF_INVALID');
    }
  });
});
